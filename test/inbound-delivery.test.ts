import type { Element, XmppClient } from '@xmpp/client';
import type { OpenClawConfig, PluginRuntime } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleInboundMessage, handleInboundReaction } from '../src/inbound.js';
import { setXmppRuntime } from '../src/runtime.js';
import { activeClients, cleanupAccountState } from '../src/state.js';
import type { XmppConfig, XmppInboundMessage } from '../src/types.js';

type DispatchParams = Parameters<
  PluginRuntime['channel']['reply']['dispatchReplyWithBufferedBlockDispatcher']
>[0];

const accountId = 'delivery-test';
const config: XmppConfig = {
  jid: 'bot@example.com',
  password: 'unused-test-value',
  dmPolicy: 'open',
  sendReadReceipts: false,
};
const cfg: OpenClawConfig = { channels: { xmpp: config } };
const message: XmppInboundMessage = {
  id: 'message-1',
  from: 'user@example.com/mobile',
  to: 'bot@example.com',
  body: 'hello',
  type: 'chat',
  timestamp: 1,
  isGroup: false,
};

function createDeliveryHarness() {
  const send = vi.fn<[Element], Promise<void>>().mockResolvedValue(undefined);
  activeClients.set(accountId, {
    send,
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as XmppClient);
  const recordInboundSession = vi.fn().mockResolvedValue(undefined);
  const dispatch = vi.fn((_params: DispatchParams) => Promise.resolve({ queuedFinal: false }));
  setXmppRuntime({
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: 'agent',
          sessionKey: 'session',
          mainSessionKey: 'main-session',
          accountId,
        }),
      },
      session: {
        resolveStorePath: () => 'test-sessions.json',
        recordInboundSession,
      },
      reply: {
        finalizeInboundContext: (context: Record<string, unknown>) => context,
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
      },
    },
  } as unknown as PluginRuntime);
  return { send, dispatch, recordInboundSession };
}

beforeEach(() => {
  vi.useFakeTimers();
  cleanupAccountState(accountId);
});

afterEach(async () => {
  try {
    // Flush pending batches even after a failed assertion so their private entries are removed.
    await vi.runOnlyPendingTimersAsync();
  } finally {
    cleanupAccountState(accountId);
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

describe('inbound delivery Promise contracts', () => {
  it('resolves after enqueueing and batches replies until 500 ms after the last payload', async () => {
    const { send, dispatch } = createDeliveryHarness();
    dispatch.mockImplementationOnce(async ({ dispatcherOptions: { deliver } }) => {
      const first = deliver({ text: 'first' }, { kind: 'block' });

      expect(first).toBeInstanceOf(Promise);
      expect(vi.getTimerCount()).toBe(1);
      await expect(first).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(250);
      const second = deliver({ text: 'second' }, { kind: 'final' });

      expect(second).toBeInstanceOf(Promise);
      expect(vi.getTimerCount()).toBe(1);
      await expect(second).resolves.toBeUndefined();
      return { queuedFinal: true };
    });

    await handleInboundMessage(message, cfg, accountId, config);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].getChild('composing')).toBeDefined();
    await vi.advanceTimersByTimeAsync(499);
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(vi.getTimerCount()).toBe(0);
    expect(send).toHaveBeenCalledTimes(3);
    const reply = send.mock.calls[1][0];
    expect(reply.attrs.to).toBe('user@example.com');
    expect(reply.getChildText('body')).toBe('> hello\n>\nfirst\n\nsecond');
    expect(reply.getChild('reply', 'urn:xmpp:reply:0')?.attrs.id).toBe('message-1');
    expect(send.mock.calls[2][0].getChild('active')).toBeDefined();
  });

  it('resolves reaction delivery to undefined without sending or scheduling work', async () => {
    const { send, dispatch, recordInboundSession } = createDeliveryHarness();
    const setStatus = vi.fn();
    dispatch.mockImplementationOnce(async ({ dispatcherOptions: { deliver } }) => {
      const result = deliver({ text: 'ignored reply' }, { kind: 'final' });

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(setStatus).toHaveBeenCalledOnce();
      expect(recordInboundSession).toHaveBeenCalledOnce();
      return { queuedFinal: true };
    });

    await handleInboundReaction({
      reactedMessageId: 'message-1',
      emojis: ['👍'],
      senderBare: 'user@example.com',
      senderFull: message.from,
      isGroup: false,
      cfg,
      accountId,
      config,
      setStatus,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledOnce();
    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
