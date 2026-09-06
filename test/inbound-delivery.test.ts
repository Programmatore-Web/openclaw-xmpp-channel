import { xml } from '@xmpp/client';
import type { Element, XmppClient } from '@xmpp/client';
import type { OpenClawConfig, PluginRuntime } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleInboundMessage, handleInboundReaction } from '../src/inbound.js';
import { setupMessageHandler } from '../src/monitor.js';
import { setXmppRuntime } from '../src/runtime.js';
import { activeClients, cleanupAccountState, getRecentInboundMessageId } from '../src/state.js';
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

describe('inbound ID producer/consumer invariants', () => {
  const room = 'room@conference.example.com';

  it.each([
    {
      name: 'prefers the normalized group stanza ID over the message ID',
      isGroup: true,
      expectedContextId: 'server-id',
      expectedRecentId: 'server-id',
    },
    {
      name: 'uses the group message ID when the producer rejects the stanza ID',
      isGroup: true,
      stanzaBy: 'other@conference.example.com',
      expectedContextId: 'raw-id',
      expectedRecentId: 'raw-id',
    },
    {
      name: 'prefers the DM origin ID over the raw ID while retaining the context stanza ID',
      isGroup: false,
      originId: 'origin-id',
      expectedContextId: 'server-id',
      expectedRecentId: 'origin-id',
    },
    {
      name: 'uses the DM raw ID when the origin ID is absent',
      isGroup: false,
      expectedContextId: 'server-id',
      expectedRecentId: 'raw-id',
    },
    {
      name: 'uses the DM raw ID after the producer normalizes an empty origin ID',
      isGroup: false,
      originId: '',
      expectedContextId: 'server-id',
      expectedRecentId: 'raw-id',
    },
    {
      name: 'retains the generated message ID fallback for an empty DM raw ID',
      isGroup: false,
      rawId: '',
      expectedContextId: 'server-id',
      expectedRecentId: 'msg_1000',
    },
  ])('$name', async ({ isGroup, stanzaBy, originId, rawId, expectedContextId, expectedRecentId }) => {
    vi.setSystemTime(1000);
    const { dispatch, recordInboundSession } = createDeliveryHarness();
    const accountConfig: XmppConfig = { ...config, groupPolicy: 'open', groups: [room] };
    const accountCfg: OpenClawConfig = { channels: { xmpp: accountConfig } };
    let listener: ((stanza: Element) => void) | undefined;
    const xmpp = {
      on: vi.fn((event: string, handler: (stanza: Element) => void) => {
        if (event === 'stanza') listener = handler;
      }),
    } as unknown as XmppClient;
    const log = { error: vi.fn() };
    setupMessageHandler(xmpp, accountId, 'bot', accountCfg, accountConfig, log);
    if (!listener) throw new Error('message listener was not registered');

    const stanza = xml(
      'message',
      {
        from: isGroup ? `${room}/user` : message.from,
        to: config.jid,
        type: isGroup ? 'groupchat' : 'chat',
        id: rawId ?? 'raw-id',
      },
      xml('body', {}, 'hello'),
      xml('stanza-id', {
        xmlns: 'urn:xmpp:sid:0',
        id: 'server-id',
        by: stanzaBy ?? (isGroup ? room : 'example.com'),
      }),
      ...(originId === undefined ? [] : [xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: originId })])
    );

    expect(listener(stanza)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).not.toHaveBeenCalled();
    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ MessageSid: expectedContextId, messageId: expectedContextId }),
      })
    );
    expect(getRecentInboundMessageId(accountId, isGroup ? room : 'user@example.com')).toBe(
      expectedRecentId
    );
    expect(vi.getTimerCount()).toBe(0);
  });
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
