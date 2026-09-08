import { expect, it, vi } from 'vitest';
import type { GatewayStartContext } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  guard: vi.fn(() => {
    throw new Error('Unsupported xmpp.js runtime: revalidate before upgrading.');
  }),
  client: vi.fn(),
}));
vi.mock('../src/xmpp-runtime-compat.js', () => ({ assertXmppRuntimeCompatible: mocks.guard }));
vi.mock('../src/xmpp.js', async (original) => ({
  ...(await original<typeof import('@xmpp/client')>()),
  client: mocks.client,
}));

import plugin from '../index.js';
import { startXmppConnection } from '../src/monitor.js';
import { governTransport } from '../src/transport.js';

it('fails before registration advertises a compatible channel', () => {
  const registerChannel = vi.fn();
  expect(() => plugin.register({ registerChannel } as never)).toThrow(
    'Unsupported xmpp.js runtime'
  );
  expect(registerChannel).not.toHaveBeenCalled();
});

it('fails before client construction and native reconnect/state access', async () => {
  await expect(
    startXmppConnection({
      accountId: 'compat-failure',
      account: {
        accountId: 'compat-failure',
        enabled: true,
        config: { jid: 'bot@example.com', password: 'fixture' },
      },
      cfg: {},
      setStatus: vi.fn(),
    } as GatewayStartContext)
  ).rejects.toThrow('Unsupported xmpp.js runtime');
  expect(mocks.client).not.toHaveBeenCalled();
});

it('fails before transport adaptation reads or writes any private internal', () => {
  const get = vi.fn(() => {
    throw new Error('Private internal was accessed');
  });
  const set = vi.fn(() => {
    throw new Error('Private internal was changed');
  });
  expect(() => governTransport(new Proxy({}, { get, set }) as never, () => true, vi.fn())).toThrow(
    'Unsupported xmpp.js runtime'
  );
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
