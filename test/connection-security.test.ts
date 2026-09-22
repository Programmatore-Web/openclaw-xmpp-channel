import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStartContext, ResolvedXmppAccount } from '../src/types.js';

const xmppMocks = vi.hoisted(() => {
  let startupOnline: (() => void) | undefined;
  let applicationOnlineRegistered = false;
  const clientInstance = {
    status: 'offline',
    options: { service: '', domain: '' },
    isSecure: vi.fn(() => true),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'online') {
        if (applicationOnlineRegistered) startupOnline = handler;
        else applicationOnlineRegistered = true;
      }
    }),
    off: vi.fn(),
    connect: vi.fn(async () => undefined),
    open: vi.fn(async () => startupOnline?.()),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  };
  return {
    clientInstance,
    client: vi.fn((options: { service: string; domain: string }) => {
      applicationOnlineRegistered = false;
      startupOnline = undefined;
      clientInstance.options = options;
      return clientInstance;
    }),
    xml: vi.fn((name: string, attrs: Record<string, string> = {}) => ({ name, attrs })),
  };
});

vi.mock('../src/xmpp.js', () => ({ client: xmppMocks.client, xml: xmppMocks.xml }));

import { startXmppConnection } from '../src/monitor.js';
import { cleanupAccountState } from '../src/state.js';

const accountId = 'connection-security-test';

function connectionContext(): GatewayStartContext {
  const account: ResolvedXmppAccount = {
    accountId,
    enabled: true,
    config: {
      jid: 'bot@example.com',
      password: '  whitespace is significant  ',
      server: 'xmpp-edge.example.com',
      port: 5223,
    },
  };
  const controller = new AbortController();
  controller.abort();
  return {
    account,
    accountId,
    cfg: { channels: { xmpp: account.config } } as OpenClawConfig,
    abortSignal: controller.signal,
    setStatus: vi.fn(),
  };
}

afterEach(() => {
  cleanupAccountState(accountId);
  vi.clearAllMocks();
});

describe('XMPP connection authentication', () => {
  it('uses the connect host for service and the JID domain for XMPP', async () => {
    await startXmppConnection(connectionContext());
    expect(xmppMocks.client).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'xmpp://xmpp-edge.example.com:5223',
        domain: 'example.com',
        username: 'bot',
      })
    );
  });

  it('refuses authentication before STARTTLS and preserves the password', async () => {
    await startXmppConnection(connectionContext());
    const options = xmppMocks.client.mock.calls[0]?.[0] as unknown as {
      credentials: (
        authenticate: (
          credentials: { username: string; password: string },
          mechanism: string
        ) => Promise<void>,
        mechanisms: string[],
        fast: unknown,
        entity: typeof xmppMocks.clientInstance
      ) => Promise<void>;
    };
    const authenticate = vi.fn(async () => undefined);
    xmppMocks.clientInstance.isSecure.mockReturnValueOnce(false);

    await expect(
      options.credentials(
        authenticate,
        ['SCRAM-SHA-1', 'PLAIN'],
        undefined,
        xmppMocks.clientInstance
      )
    ).rejects.toThrow('STARTTLS is required before XMPP authentication');
    expect(authenticate).not.toHaveBeenCalled();

    xmppMocks.clientInstance.isSecure.mockReturnValueOnce(true);
    await options.credentials(
      authenticate,
      ['PLAIN', 'SCRAM-SHA-1'],
      undefined,
      xmppMocks.clientInstance
    );
    expect(authenticate).toHaveBeenCalledWith(
      { username: 'bot', password: '  whitespace is significant  ' },
      'SCRAM-SHA-1'
    );
  });
});

describe('XMPP runtime secret boundary', () => {
  it.each([
    { source: 'store', provider: 'default', id: 'XMPP_TEST_PASSWORD' },
    { source: 'env', provider: 'default', id: 'XMPP_TEST_PASSWORD' },
    undefined,
    null,
    123,
    false,
    '',
    { malformed: true },
  ])('fails before client creation for unavailable runtime input %#', async (password) => {
    const ctx = connectionContext();
    ctx.account.config.password = password as any;
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    ctx.log = log;
    await expect(startXmppConnection(ctx)).rejects.toThrow(
      /XMPP (runtime password is unavailable|jid and password are required)/
    );
    expect(xmppMocks.client).not.toHaveBeenCalled();
    expect(ctx.setStatus).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each(['${XMPP_TEST_PASSWORD}', '$XMPP_TEST_PASSWORD'])(
    'passes an opaque materialized env-like password unchanged to SASL %#',
    async (password) => {
      const ctx = connectionContext();
      ctx.account.config.password = password;
      await startXmppConnection(ctx);
      const options = xmppMocks.client.mock.calls[0][0] as any;
      let observed: string | undefined;
      await options.credentials(
        async (credentials: { password: string }) => {
          observed = credentials.password;
        },
        ['SCRAM-SHA-1', 'PLAIN'],
        undefined,
        xmppMocks.clientInstance
      );
      expect(observed === password).toBe(true);
    }
  );

  it('authenticates from a materialized clone without leaking or changing the source', async () => {
    const { collectRuntimeConfigAssignments } = await import('../secret-contract-api.js');
    const { resolveXmppAccount } = await import('../src/accounts.js');
    const { xmppPlugin } = await import('../src/channel.js');
    const source = {
      channels: { xmpp: { jid: 'bot@example.com', password: '${XMPP_TEST_PASSWORD}' } },
    } as OpenClawConfig;
    const original = structuredClone(source);
    const runtime = structuredClone(source);
    const context = {
      sourceConfig: source,
      env: {},
      cache: {},
      warnings: [],
      warningKeys: new Set<string>(),
      assignments: [],
    } as import('openclaw/plugin-sdk/channel-secret-basic-runtime').ResolverContext;
    collectRuntimeConfigAssignments({ config: runtime, context });
    const sentinel = 'test-secret-value-DO-NOT-LOG';
    context.assignments[0].apply(sentinel);
    const ctx = connectionContext();
    ctx.cfg = runtime;
    ctx.account = resolveXmppAccount({ cfg: runtime });
    const capture: unknown[] = [];
    ctx.log = {
      info: (msg) => {
        capture.push(msg);
      },
      error: (msg) => {
        capture.push(msg);
      },
      debug: (msg) => {
        capture.push(msg);
      },
    };
    ctx.setStatus = (status) => {
      capture.push(status);
    };
    await startXmppConnection(ctx);
    const options = xmppMocks.client.mock.calls[0][0] as any;
    let observed: string | undefined;
    await options.credentials(
      async (credentials: { password: string }) => {
        observed = credentials.password;
      },
      ['PLAIN'],
      undefined,
      xmppMocks.clientInstance
    );
    expect(observed === sentinel).toBe(true);
    capture.push(await xmppPlugin.status!.buildChannelSummary!({ account: ctx.account } as any));
    capture.push(await xmppPlugin.status!.buildAccountSnapshot!({ account: ctx.account } as any));
    expect(JSON.stringify(capture).includes(sentinel)).toBe(false);
    expect(JSON.stringify(source).includes(sentinel)).toBe(false);
    expect(source).toEqual(original);
  });
});
