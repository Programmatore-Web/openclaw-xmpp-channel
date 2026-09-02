import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStartContext, ResolvedXmppAccount } from '../src/types.js';

const xmppMocks = vi.hoisted(() => {
  const clientInstance = {
    isSecure: vi.fn(() => true),
    on: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  };
  return {
    clientInstance,
    client: vi.fn((_options: unknown) => clientInstance),
    xml: vi.fn((name: string, attrs: Record<string, string> = {}) => ({ name, attrs })),
  };
});

vi.mock('@xmpp/client', () => ({ client: xmppMocks.client, xml: xmppMocks.xml }));

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
        authenticate: (credentials: { username: string; password: string }, mechanism: string) => Promise<void>,
        mechanisms: string[],
        fast: unknown,
        entity: typeof xmppMocks.clientInstance
      ) => Promise<void>;
    };
    const authenticate = vi.fn(async () => undefined);
    xmppMocks.clientInstance.isSecure.mockReturnValueOnce(false);

    await expect(
      options.credentials(authenticate, ['SCRAM-SHA-1', 'PLAIN'], undefined, xmppMocks.clientInstance)
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
