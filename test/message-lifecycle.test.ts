import { xml } from '@xmpp/client';
import type { Element, XmppClient } from '@xmpp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routing = vi.hoisted(() => ({ message: vi.fn(), reaction: vi.fn() }));
vi.mock('../src/inbound.js', () => ({
  handleInboundMessage: routing.message,
  handleInboundReaction: routing.reaction,
}));

import { setupMessageHandler } from '../src/monitor.js';
import { cleanupAccountState, sentMessageIds } from '../src/state.js';

const accountId = 'message-lifecycle-test';

function harness() {
  let listener: ((stanza: Element) => void) | undefined;
  const xmpp = {
    on: vi.fn((event: string, handler: (stanza: Element) => void) => {
      if (event === 'stanza') listener = handler;
    }),
  } as unknown as XmppClient;
  const log = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const setStatus = vi.fn();
  setupMessageHandler(
    xmpp,
    accountId,
    'bot',
    {},
    { jid: 'bot@example.com', password: 'password' },
    log,
    setStatus
  );
  if (!listener) throw new Error('message listener was not registered');
  return { listener, log, setStatus };
}

function message(kind = 'message') {
  return xml(
    'message',
    { from: 'user@example.com/resource', to: 'bot@example.com', id: 'message-1' },
    kind === 'reaction'
      ? xml(
          'reactions',
          { xmlns: 'urn:xmpp:reactions:0', id: 'target-1' },
          xml('reaction', {}, '👍')
        )
      : xml('body', {}, 'plaintext')
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  routing.message.mockReset().mockResolvedValue(undefined);
  routing.reaction.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanupAccountState(accountId);
  try {
    expect(sentMessageIds.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('message stanza listener lifecycle', () => {
  it.each(['message', 'reaction'] as const)(
    'handles rejected %s routing and accepts subsequent stanzas',
    async (kind) => {
      const h = harness();
      routing[kind].mockRejectedValueOnce(new Error(`${kind} failed`));
      expect(h.listener(message(kind))).toBeUndefined();
      expect(routing[kind]).toHaveBeenCalledTimes(1);
      expect(h.log.error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.log.error).toHaveBeenCalledTimes(1);
      expect(h.log.error).toHaveBeenCalledWith(
        `[${accountId}] Failed to process inbound XMPP stanza: ${kind} failed`
      );
      expect(h.setStatus).toHaveBeenCalledTimes(1);
      expect(h.setStatus).toHaveBeenCalledWith({ accountId, lastError: `${kind} failed` });

      expect(h.listener(message(kind))).toBeUndefined();
      expect(routing[kind]).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.log.error).toHaveBeenCalledTimes(1);
      expect(h.setStatus).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['log', 'status'])(
    'contains residual failure from operational %s and a failing terminal logger',
    async (report) => {
      const h = harness();
      routing.message.mockRejectedValueOnce(new Error('routing failed'));
      h.log.error.mockImplementation((message: string) => {
        if (report === 'log' || message.includes('task failed')) throw new Error('logger failed');
      });
      if (report === 'status')
        h.setStatus.mockImplementationOnce(() => {
          throw new Error('status failed');
        });
      expect(h.listener(message())).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.log.error).toHaveBeenCalledTimes(2);
      expect(h.log.error).toHaveBeenLastCalledWith(
        `[${accountId}] Inbound XMPP stanza task failed: ${report === 'log' ? 'logger' : 'status'} failed`
      );
      expect(h.listener(message())).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(routing.message).toHaveBeenCalledTimes(2);
      expect(h.log.error).toHaveBeenCalledTimes(2);
    }
  );

  it('preserves history and MUC self-message early returns in the same turn', () => {
    const h = harness();
    const history = message();
    history.append(xml('delay', { xmlns: 'urn:xmpp:delay' }));
    expect(h.listener(history)).toBeUndefined();
    const legacyHistory = message();
    legacyHistory.append(xml('x', { xmlns: 'jabber:x:delay' }));
    expect(h.listener(legacyHistory)).toBeUndefined();
    expect(
      h.listener(
        xml(
          'message',
          { from: 'room@conference.example.com/bot', type: 'groupchat' },
          xml('body', {}, 'self')
        )
      )
    ).toBeUndefined();
    expect(routing.message).not.toHaveBeenCalled();
    expect(routing.reaction).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps self-message IDs immediately and expires both mappings after five minutes', () => {
    const h = harness();
    expect(
      h.listener(
        xml(
          'message',
          { from: 'bot@example.com/resource', id: 'client-1' },
          xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', id: 'server-1' }),
          xml('body', {}, 'self')
        )
      )
    ).toBeUndefined();
    expect(sentMessageIds.get(`${accountId}:sent:server-1`)).toBe('client-1');
    expect(sentMessageIds.get(`${accountId}:client-1`)).toBe('server-1');
    expect(routing.message).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(sentMessageIds.size).toBe(2);
    vi.advanceTimersByTime(1);
    expect(sentMessageIds.size).toBe(0);
  });
});
