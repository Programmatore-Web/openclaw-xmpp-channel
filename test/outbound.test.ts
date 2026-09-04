import type { client } from '@xmpp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendXmppMessage } from '../src/outbound.js';
import { activeClients } from '../src/state.js';
import type { XmppConfig } from '../src/types.js';

const accountId = 'outbound-test';
const config: XmppConfig = {
  jid: 'bot@example.com',
  password: 'password',
};

afterEach(() => {
  activeClients.delete(accountId);
  vi.restoreAllMocks();
});

describe('outbound stanza IDs', () => {
  it('generates different IDs for two sends at the same timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const send = vi.fn(async () => undefined);
    activeClients.set(accountId, { send } as unknown as ReturnType<typeof client>);

    const [first, second] = await Promise.all([
      sendXmppMessage(config, 'user@example.com', 'first', { accountId }),
      sendXmppMessage(config, 'user@example.com', 'second', { accountId }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.messageId).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(second.messageId).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(first.messageId).not.toBe(second.messageId);
    expect(send.mock.calls.map(([stanza]) => stanza.attrs.id)).toEqual([
      first.messageId,
      second.messageId,
    ]);
  });
});
