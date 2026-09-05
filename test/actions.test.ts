import type { Element } from '@xmpp/client';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xmppMessageActions } from '../src/actions.js';
import * as state from '../src/state.js';

const { send } = vi.hoisted(() => ({
  send: vi.fn<(stanza: Element) => Promise<void>>(),
}));

vi.mock('../src/monitor.js', () => ({
  getActiveClient: () => ({ send }),
}));

const accountId = 'actions-test';
const target = 'user@example.com';
const cfg: OpenClawConfig = {
  channels: {
    xmpp: {
      accounts: {
        [accountId]: { jid: 'bot@example.com', actions: { reactions: true } },
      },
    },
  },
};

const invalidCandidates = [
  { name: 'undefined', value: undefined },
  { name: 'null', value: null },
  { name: 'false', value: false },
  { name: 'zero', value: 0 },
  { name: 'nonzero number', value: 42 },
  { name: 'object', value: { jid: target } },
  { name: 'array', value: [target] },
  { name: 'true', value: true },
  { name: 'boxed string', value: new String(target) },
  { name: 'empty string', value: '' },
];

function react(params: Record<string, unknown>, currentChannelId?: string) {
  return xmppMessageActions.handleAction({
    action: 'react',
    params,
    cfg,
    accountId,
    toolContext: { currentChannelId },
  });
}

function expectReaction(to: string, messageId: string) {
  expect(send).toHaveBeenCalledTimes(1);
  const stanza = send.mock.calls[0]?.[0];
  expect(stanza?.attrs.to).toBe(to);
  expect(stanza?.getChild('reactions', 'urn:xmpp:reactions:0')?.attrs.id).toBe(messageId);
}

beforeEach(() => {
  state.cleanupAccountState(accountId);
  send.mockReset();
  send.mockResolvedValue(undefined);
});

afterEach(() => {
  state.cleanupAccountState(accountId);
  vi.restoreAllMocks();
});

describe('reaction action string inputs', () => {
  it.each(invalidCandidates)('rejects a $name target without a fallback', async ({ value }) => {
    const result = await react({ chatJid: value, messageId: 'explicit-id' });

    expect(result.details).toEqual({ ok: false, error: 'Target JID is required' });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses to before currentChannelId when chatJid is not a string', async () => {
    await react(
      { chatJid: { invalid: true }, to: target, messageId: 'explicit-id' },
      'room@conference.example.com'
    );

    expectReaction(target, 'explicit-id');
  });

  it('uses currentChannelId when both target parameters are not strings', async () => {
    await react({ chatJid: { invalid: true }, to: true, messageId: 'explicit-id' }, target);

    expectReaction(target, 'explicit-id');
  });

  it('uses a nonempty chatJid before to and currentChannelId', async () => {
    await react(
      { chatJid: target, to: 'room@conference.example.com', messageId: 'explicit-id' },
      'bot@example.com'
    );

    expectReaction(target, 'explicit-id');
  });

  it.each([
    { name: 'to', to: target },
    { name: 'currentChannelId', to: '' },
  ])('uses $name after empty target strings', async ({ to }) => {
    await react({ chatJid: '', to, messageId: 'explicit-id' }, target);

    expectReaction(target, 'explicit-id');
  });

  it.each(invalidCandidates)(
    'rejects a $name messageId without a recent inbound ID',
    async ({ value }) => {
      const result = await react({ chatJid: target, messageId: value });

      expect(result.details).toEqual({
        ok: false,
        error: 'messageId is required for reactions',
      });
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('uses the recent inbound ID when messageId is not a string', async () => {
    state.recordInboundMessageId(accountId, target, 'recent-id');
    const getServerMessageId = vi.spyOn(state, 'getServerMessageId');

    await react({ chatJid: target, messageId: { invalid: true } });

    expect(getServerMessageId).toHaveBeenCalledWith(accountId, 'recent-id', target);
    expectReaction(target, 'recent-id');
  });

  it('uses the recent inbound ID when messageId is empty', async () => {
    state.recordInboundMessageId(accountId, target, 'recent-id');
    const getServerMessageId = vi.spyOn(state, 'getServerMessageId');

    await react({ chatJid: target, messageId: '' });

    expect(getServerMessageId).toHaveBeenCalledWith(accountId, 'recent-id', target);
    expectReaction(target, 'recent-id');
  });

  it('uses a nonempty explicit messageId before the recent inbound ID', async () => {
    state.recordInboundMessageId(accountId, target, 'recent-id');
    state.sentMessageIds.set(`${accountId}:explicit-id`, 'server-id');

    await react({ chatJid: target, messageId: 'explicit-id' });

    expectReaction(target, 'server-id');
  });

  it.each([
    { name: 'whitespace-only', chatJid: ' ', messageId: ' ' },
    { name: 'padded', chatJid: ' user@example.com ', messageId: ' explicit-id ' },
  ])('preserves $name strings without trimming', async ({ chatJid, messageId }) => {
    await react({ chatJid, to: target, messageId }, 'room@conference.example.com');

    expectReaction(chatJid, messageId);
  });

  it('keeps target normalization for the recent inbound lookup and the stanza', async () => {
    state.recordInboundMessageId(accountId, target, 'recent-id');

    await react({ chatJid: `xmpp:${target}/resource`, messageId: { invalid: true } });

    expectReaction(target, 'recent-id');
  });
});
