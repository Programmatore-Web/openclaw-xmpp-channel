import { execFile } from 'node:child_process';
import net, { type AddressInfo, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { describe, expect, it, vi } from 'vitest';
import { startXmppConnection } from '../src/monitor.js';
import { activeClients, reconnectStates } from '../src/state.js';
import type { GatewayStartContext, ResolvedXmppAccount } from '../src/types.js';

const CHILD_ENV = 'OPENCLAW_XMPP_TRANSPORT_FAILURE_CHILD';
const accountId = 'transport-failure-test';

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runStrictChild(): Promise<{ stdout: string; stderr: string }> {
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        vitest,
        '--run',
        '--disableConsoleIntercept',
        'test/transport-failure.test.ts',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, [CHILD_ENV]: '1' },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Strict transport-failure child failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

describe('real XMPP transport failure containment', () => {
  if (process.env[CHILD_ENV] !== '1') {
    it('survives a pre-authentication loopback transport failure under strict rejection handling', async () => {
      const result = await runStrictChild();

      expect(result.stdout).toContain('FIXTURE_ACCEPTED_INITIAL_BYTES');
      expect(result.stdout).toContain('EXPECTED_XMPP_FAILURE_OBSERVED');
      expect(result.stdout).toContain('TRANSPORT_FAILURE_PROCESS_SURVIVED');
      expect(result.stdout).not.toContain('triggerUncaughtException');
      expect(result.stderr).not.toContain('UnhandledPromiseRejection');
      expect(result.stderr).not.toContain('uncaughtException');
    }, 15_000);
    return;
  }

  it('runs the real transport failure scenario in the isolated child', async () => {
    const sockets = new Set<Socket>();
    let acceptedConnections = 0;
    let closePromise: Promise<void> | undefined;
    let initialBytesResolve!: () => void;
    const initialBytes = new Promise<void>((resolve) => {
      initialBytesResolve = resolve;
    });
    const server = net.createServer((socket) => {
      acceptedConnections++;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', () => {
        console.log('FIXTURE_ACCEPTED_INITIAL_BYTES');
        initialBytesResolve();
        socket.destroy();
        void closeFixture();
      });
    });
    const closeFixture = (): Promise<void> => {
      closePromise ??= new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closePromise;
    };

    const controller = new AbortController();
    const statuses: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    let connectionFailures = 0;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let lifetime: Promise<void> | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address() as AddressInfo;
      const account: ResolvedXmppAccount = {
        accountId,
        enabled: true,
        config: {
          jid: 'bot@example.com',
          password: 'disposable-test-value',
          server: '127.0.0.1',
          port: address.port,
        },
      };
      const log = {
        debug: vi.fn((message: string) => logs.push(message)),
        info: vi.fn((message: string) => logs.push(message)),
        warn: vi.fn((message: string) => logs.push(message)),
        error: vi.fn((message: string) => {
          logs.push(message);
          if (message.includes('XMPP connection failed:')) {
            connectionFailures++;
            if (connectionFailures === 1) {
              console.log('EXPECTED_XMPP_FAILURE_OBSERVED');
            } else if (connectionFailures === 2) {
              abortTimer = setTimeout(() => controller.abort(), 1_200);
            }
          }
        }),
      };
      const ctx: GatewayStartContext = {
        accountId,
        account,
        cfg: { channels: { xmpp: account.config } } as OpenClawConfig,
        abortSignal: controller.signal,
        log,
        setStatus: (patch) => statuses.push(patch),
      };

      lifetime = startXmppConnection(ctx);
      await within(initialBytes, 2_000, 'the fixture connection');
      await within(lifetime, 4_000, 'the account lifetime to stop');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(acceptedConnections).toBe(1);
      // The initial clean socket close fails startup directly. Only the plugin's
      // scheduled retry emits ECONNREFUSED; no hidden native retry is needed.
      expect(logs.filter((message) => message.includes('XMPP error:'))).toHaveLength(1);
      expect(logs).toContain(
        `[${accountId}] XMPP connection failed: XMPP disconnected before online`
      );
      expect(logs.filter((message) => message.includes('XMPP connection failed:'))).toHaveLength(2);
      expect(logs.some((message) => message.includes('Scheduling reconnect in 1000ms'))).toBe(true);
      expect(logs.some((message) => message.includes('Scheduling reconnect in 2000ms'))).toBe(true);
      expect(logs.filter((message) => message.includes('Attempting reconnect'))).toHaveLength(1);
      expect(statuses.some((status) => typeof status.lastError === 'string')).toBe(true);
      expect(statuses).toContainEqual(
        expect.objectContaining({ accountId, running: false, connected: false })
      );
      expect(activeClients.has(accountId)).toBe(false);
      expect(reconnectStates.has(accountId)).toBe(false);
      console.log('TRANSPORT_FAILURE_PROCESS_SURVIVED');
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      controller.abort();
      if (lifetime) await within(lifetime, 2_000, 'final account cleanup');
      for (const socket of sockets) socket.destroy();
      await closeFixture();
    }
  }, 8_000);
});
