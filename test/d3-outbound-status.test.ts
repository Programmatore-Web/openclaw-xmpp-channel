import { EventEmitter } from 'node:events';
import { xml, type Element } from '@xmpp/client';
import type { PluginRuntime } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStartContext, XmppConfig } from '../src/types.js';

const mocks = vi.hoisted(() => ({ client: vi.fn(), joinMuc: vi.fn() }));
vi.mock('../src/xmpp.js', async (original) => ({
  ...(await original<typeof import('../src/xmpp.js')>()),
  client: mocks.client,
}));
vi.mock('../src/rooms.js', () => ({ joinMuc: mocks.joinMuc }));

import { startXmppConnection } from '../src/monitor.js';
import { xmppPlugin } from '../src/channel.js';
import { sendXmppMessage } from '../src/outbound.js';
import { setXmppRuntime } from '../src/runtime.js';
import { accountLifecycles, activeClients, cleanupAccountState } from '../src/state.js';
import { trackMucOccupantIdentity } from '../src/muc-identity.js';

type Dispatch = Parameters<
  PluginRuntime['channel']['reply']['dispatchReplyWithBufferedBlockDispatcher']
>[0];
const accountId = 'default';
const room = 'room@conference.example.com';
let controllers: AbortController[];
let lifetimes: Promise<void>[];
let releases: Array<() => void>;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  releases.push(resolve);
  return { promise, resolve, reject };
}

async function fixture() {
  const config: XmppConfig = {
    jid: 'bot@example.com',
    password: 'fixture',
    allowFrom: ['user@example.com'],
    dmPolicy: 'disabled',
    groups: [room],
    groupAllowFrom: ['user@example.com'],
    sendReadReceipts: true,
  };
  const cfg = { channels: { xmpp: config } };
  const events = new EventEmitter();
  const physical = vi.fn(async (_stanza: Element) => {});
  const xmpp = Object.assign(events, {
    status: 'offline',
    options: { service: 'xmpp://example.com:5222', domain: 'example.com' },
    reconnect: { stop: vi.fn() },
    connect: async () => {},
    open: async () => {
      xmpp.status = 'online';
      xmpp.emit('online', { toString: () => 'bot@example.com/fixture' });
    },
    stop: async () => {},
    send: async (stanza: Element) => {
      if (stanza.getChild('query', 'jabber:iq:roster')) {
        queueMicrotask(() =>
          events.emit(
            'stanza',
            xml(
              'iq',
              { type: 'result', id: stanza.attrs.id },
              xml('query', { xmlns: 'jabber:iq:roster' })
            )
          )
        );
      }
      await physical(stanza);
    },
  });
  mocks.client.mockReturnValue(xmpp);
  mocks.joinMuc.mockResolvedValue(undefined);
  const status: Record<string, unknown> = { accountId, lastInboundAt: null, lastOutboundAt: null };
  const setStatus = vi.fn((patch) => Object.assign(status, patch));
  const controller = new AbortController();
  controllers.push(controller);
  const ctx: GatewayStartContext = {
    accountId,
    cfg,
    account: { accountId, enabled: true, config },
    abortSignal: controller.signal,
    setStatus,
    getStatus: () => ({ accountId, ...status }),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const dispatch = vi.fn(async (_params: Dispatch) => ({ queuedFinal: false }));
  setXmppRuntime({
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: 'main',
          accountId,
          sessionKey: 'fixture-session',
          mainSessionKey: 'fixture-main',
        }),
      },
      session: {
        resolveStorePath: () => 'fixture-sessions.json',
        recordInboundSession: async () => {},
      },
      reply: {
        finalizeInboundContext: (context: unknown) => context,
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
      },
    },
  } as unknown as PluginRuntime);
  lifetimes.push(startXmppConnection(ctx));
  await vi.advanceTimersByTimeAsync(0);
  expect(status).toMatchObject({ connected: true, running: true, lastError: null });
  const initialPresence = physical.mock.calls
    .map(([stanza]) => stanza)
    .filter((stanza) => stanza.name === 'presence' && !stanza.attrs.to && !stanza.attrs.type);
  physical.mockClear();
  setStatus.mockClear();
  const inbound = (group = false) => {
    if (group)
      trackMucOccupantIdentity(
        xml(
          'presence',
          { from: `${room}/user` },
          xml(
            'x',
            { xmlns: 'http://jabber.org/protocol/muc#user' },
            xml('item', { jid: 'user@example.com/mobile' })
          )
        ),
        accountId
      );
    xmpp.emit(
      'stanza',
      xml(
        'message',
        {
          from: group ? `${room}/user` : 'user@example.com/mobile',
          to: config.jid,
          type: group ? 'groupchat' : 'chat',
          id: `inbound-${Date.now()}`,
        },
        xml('body', {}, 'hello')
      )
    );
  };
  const direct = (text = 'D3-OK', to = 'user@example.com') =>
    xmppPlugin.outbound!.sendText!({ cfg, accountId, to, text });
  const visible = () =>
    physical.mock.calls
      .map(([stanza]) => stanza)
      .filter((stanza) => stanza.getChildText('body')?.trim());
  const broadcasts = () => [
    ...initialPresence,
    ...physical.mock.calls
      .map(([stanza]) => stanza)
      .filter((stanza) => stanza.name === 'presence' && !stanza.attrs.to && !stanza.attrs.type),
  ];
  return {
    xmpp,
    physical,
    status,
    setStatus,
    ctx,
    controller,
    dispatch,
    inbound,
    direct,
    visible,
    broadcasts,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  controllers = [];
  lifetimes = [];
  releases = [];
});
afterEach(async () => {
  controllers.forEach((controller) => controller.abort());
  releases.forEach((release) => release());
  await Promise.all(lifetimes);
  await vi.runOnlyPendingTimersAsync();
  cleanupAccountState(accountId);
  expect(activeClients.size).toBe(0);
  expect(accountLifecycles.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('D3 physical outbound status ownership', () => {
  it.each([false, true])(
    'authorized inbound reply via outbound adapter, group=%s',
    async (group) => {
      const h = await fixture();
      const send = deferred();
      h.physical.mockImplementation(async (stanza) => {
        if (stanza.getChild('body')) await send.promise;
      });
      h.dispatch.mockImplementation(async () => {
        await h.direct('D3-OK', group ? room : 'user@example.com');
        return { queuedFinal: true };
      });
      h.inbound(group);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.visible()).toHaveLength(1);
      expect(h.status).toMatchObject({
        lastInboundAt: 10_000,
        lastOutboundAt: null,
        activeRuns: 1,
        busy: true,
      });
      vi.setSystemTime(11_000);
      send.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.status).toMatchObject({
        lastOutboundAt: 11_000,
        lastError: null,
        activeRuns: 0,
        busy: false,
      });
      expect(h.setStatus.mock.calls.filter(([patch]) => patch.lastOutboundAt)).toHaveLength(1);
    }
  );

  it('advances for two consecutive replies and starts correctly in a clean lifecycle', async () => {
    for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
      const h = await fixture();
      expect(h.status.lastOutboundAt).toBeNull();
      h.dispatch.mockImplementation(async () => {
        await h.direct();
        return { queuedFinal: true };
      });
      for (const timestamp of [20_000, 30_000]) {
        vi.setSystemTime(timestamp);
        h.inbound();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.status).toMatchObject({ lastInboundAt: timestamp, lastOutboundAt: timestamp });
      }
      h.controller.abort();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it.each(['adapter', 'callback'] as const)(
    'failed %s send keeps timestamp and reports error',
    async (path) => {
      const h = await fixture();
      h.status.lastOutboundAt = 5_000;
      h.physical.mockImplementation(async (stanza) => {
        if (stanza.getChild('body')) throw new Error('fixture send failed');
      });
      if (path === 'adapter') await expect(h.direct()).rejects.toThrow('fixture send failed');
      else {
        h.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
          await dispatcherOptions.deliver({ text: 'D3-OK' }, { kind: 'final' });
          return { queuedFinal: true };
        });
        h.inbound();
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(h.status).toMatchObject({
        lastOutboundAt: 5_000,
        lastError: 'fixture send failed',
        busy: false,
      });
    }
  );

  describe.each(['client', 'message', 'adapter'] as const)('throwing status sink: %s', (path) => {
    it('preserves physical success without sending a duplicate', async () => {
      const h = await fixture();
      const send = deferred();
      const events: string[] = [];
      h.physical.mockImplementation(async () => {
        events.push('sending');
        await send.promise;
        events.push('sent');
      });
      h.setStatus.mockImplementation((patch) => {
        if (patch.lastOutboundAt !== undefined) {
          events.push('status');
          throw new Error('fixture status publication failed');
        }
        return Object.assign(h.status, patch);
      });
      const result = (
        path === 'client'
          ? h.xmpp.send(xml('message', { type: 'chat' }, xml('body', {}, 'D3-P2-OK')))
          : path === 'message'
            ? sendXmppMessage(h.ctx.account.config, 'user@example.com', 'D3-P2-OK')
            : h.direct('D3-P2-OK')
      ).then(
        (value) => ({ succeeded: true, value }),
        (error: unknown) => ({ succeeded: false, error })
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['sending']);
      expect(h.setStatus).not.toHaveBeenCalled();
      expect(h.status.lastOutboundAt).toBeNull();
      send.resolve();
      const expected =
        path === 'client'
          ? undefined
          : path === 'message'
            ? { ok: true, messageId: expect.any(String) }
            : { channel: 'xmpp', messageId: expect.any(String) };
      expect(await result).toEqual({ succeeded: true, value: expected });
      await vi.advanceTimersByTimeAsync(500);
      expect(events).toEqual(['sending', 'sent', 'status']);
      expect(h.setStatus).toHaveBeenCalledExactlyOnceWith({ accountId, lastOutboundAt: 10_000 });
      expect(h.status).toMatchObject({ lastOutboundAt: null, lastError: null });
      expect(h.physical).toHaveBeenCalledTimes(1);
      expect(h.visible()).toHaveLength(1);
    });

    it('preserves the original physical failure when error publication throws', async () => {
      const h = await fixture();
      const send = deferred();
      const physicalError = new Error('fixture original physical failure');
      const statusError = new Error('fixture status publication failed');
      h.status.lastOutboundAt = 5_000;
      h.physical.mockImplementation(async () => send.promise);
      h.setStatus.mockImplementation((patch) => {
        if (patch.lastError !== undefined) throw statusError;
        return Object.assign(h.status, patch);
      });
      const result = (
        path === 'client'
          ? h.xmpp.send(xml('message', { type: 'chat' }, xml('body', {}, 'D3-P2-FAIL')))
          : path === 'message'
            ? sendXmppMessage(h.ctx.account.config, 'user@example.com', 'D3-P2-FAIL')
            : h.direct('D3-P2-FAIL')
      ).then(
        (value) => ({ succeeded: true as const, value }),
        (error: unknown) => ({ succeeded: false as const, error })
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.setStatus).not.toHaveBeenCalled();
      send.reject(physicalError);
      const outcome = await result;
      if (path === 'message') {
        expect(outcome).toEqual({
          succeeded: true,
          value: { ok: false, error: physicalError.message },
        });
      } else {
        expect(outcome.succeeded).toBe(false);
        if (!outcome.succeeded) {
          if (path === 'client') expect(outcome.error).toBe(physicalError);
          else expect(outcome.error).toEqual(physicalError);
          expect(outcome.error).not.toBe(statusError);
        }
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(h.setStatus).toHaveBeenCalledExactlyOnceWith({
        accountId,
        lastError: physicalError.message,
      });
      expect(h.status.lastOutboundAt).toBe(5_000);
      expect(h.physical).toHaveBeenCalledTimes(1);
    });
  });

  it.each([false, true])(
    'delayed callback retains status after dispatch ends, group=%s',
    async (group) => {
      const h = await fixture();
      const send = deferred();
      h.physical.mockImplementation(async (stanza) => {
        if (stanza.getChild('body')) await send.promise;
      });
      h.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: 'first' }, { kind: 'block' });
        await dispatcherOptions.deliver({ text: 'second' }, { kind: 'final' });
        return { queuedFinal: true };
      });
      h.inbound(group);
      await vi.advanceTimersByTimeAsync(499);
      expect(h.visible()).toHaveLength(0);
      expect(h.status.lastOutboundAt).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.visible()).toHaveLength(1);
      expect(h.visible()[0].getChildText('body')).toBe('> hello\n>\nfirst\n\nsecond');
      expect(h.status).toMatchObject({ busy: false, activeRuns: 0, lastOutboundAt: null });
      send.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.status).toMatchObject({
        lastInboundAt: 10_000,
        lastOutboundAt: 10_500,
        lastError: null,
      });
      expect(h.setStatus.mock.calls.filter(([patch]) => patch.lastOutboundAt)).toHaveLength(1);
    }
  );

  it('does not count presence, receipts, reactions or empty bodies', async () => {
    const h = await fixture();
    for (const stanza of [
      xml('presence'),
      xml('iq'),
      xml('message', {}, xml('body', {}, '  ')),
      xml('message', {}, xml('active', { xmlns: 'http://jabber.org/protocol/chatstates' })),
      xml('message', {}, xml('displayed', { xmlns: 'urn:xmpp:chat-markers:0', id: 'fixture' })),
      xml('message', {}, xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'fixture' })),
    ]) {
      await h.xmpp.send(stanza);
    }
    h.inbound();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status).toMatchObject({ lastInboundAt: 10_000, lastOutboundAt: null });
  });

  it.each(['NO_REPLY', 'REPLY_SKIP', ' no_reply '])(
    'suppresses control payload %s before sending',
    async (text) => {
      const h = await fixture();
      const payload = xmppPlugin.outbound!.normalizePayload!({
        payload: { text },
        cfg: h.ctx.cfg,
        accountId,
      });
      expect(payload).toBeNull();
      expect(h.visible()).toHaveLength(0);
      expect(h.status.lastOutboundAt).toBeNull();
    }
  );

  it('does not move a delayed old reply into a replacement client or its buffer', async () => {
    const old = await fixture();
    old.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'old' }, { kind: 'final' });
      return { queuedFinal: true };
    });
    old.inbound();
    await vi.advanceTimersByTimeAsync(250);
    const current = await fixture();
    current.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'current' }, { kind: 'final' });
      return { queuedFinal: true };
    });
    const previousStatus = { ...old.status };
    current.inbound();
    await vi.advanceTimersByTimeAsync(500);
    expect(old.visible()).toHaveLength(0);
    expect(old.status).toEqual(previousStatus);
    expect(current.visible()).toHaveLength(1);
    expect(current.visible()[0].getChildText('body')).toBe('> hello\n>\ncurrent');
    expect(current.status.lastOutboundAt).toBe(10_750);
  });

  it('a late old dispatcher cannot replace the current pending batch', async () => {
    const old = await fixture();
    const model = deferred();
    old.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
      await model.promise;
      await dispatcherOptions.deliver({ text: 'obsolete' }, { kind: 'final' });
      return { queuedFinal: true };
    });
    old.inbound();
    await vi.advanceTimersByTimeAsync(0);
    const current = await fixture();
    current.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'current' }, { kind: 'final' });
      return { queuedFinal: true };
    });
    current.inbound();
    await vi.advanceTimersByTimeAsync(250);
    const before = current.physical.mock.calls.length;
    model.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(current.physical).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(250);
    expect(current.visible()).toHaveLength(1);
    expect(current.visible()[0].getChildText('body')).toBe('> hello\n>\ncurrent');
    expect(current.status.lastOutboundAt).toBe(10_500);
    expect(old.visible()).toHaveLength(0);
  });

  it.each([{}, { text: '  ' }, { text: 'NO_REPLY' }, { markdown: 'REPLY_SKIP' }])(
    'does not count a no-visible callback reply %j',
    async (payload) => {
      const h = await fixture();
      h.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(payload, { kind: 'final' });
        return { queuedFinal: true };
      });
      h.inbound();
      await vi.advanceTimersByTimeAsync(500);
      expect(h.visible()).toHaveLength(0);
      expect(h.status).toMatchObject({ lastInboundAt: 10_000, lastOutboundAt: null });
    }
  );

  it('discards a delayed batch after abort without any replacement', async () => {
    const h = await fixture();
    h.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: 'obsolete' }, { kind: 'final' });
      return { queuedFinal: true };
    });
    h.inbound();
    await vi.advanceTimersByTimeAsync(250);
    h.controller.abort();
    const stopped = { ...h.status };
    await vi.advanceTimersByTimeAsync(500);
    expect(h.visible()).toHaveLength(0);
    expect(h.status).toEqual(stopped);
  });

  it('D6 accepts simultaneous authorized DM runs and keeps available through 2, 1, 0 active runs', async () => {
    const h = await fixture();
    const first = deferred();
    const second = deferred();
    let sends = 0;
    h.physical.mockImplementation(async (stanza) => {
      if (stanza.getChild('body')) await (++sends === 1 ? first.promise : second.promise);
    });
    h.dispatch.mockImplementation(async () => {
      await h.direct();
      return { queuedFinal: true };
    });
    h.inbound();
    await vi.advanceTimersByTimeAsync(1);
    h.inbound();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status).toMatchObject({ busy: true, activeRuns: 2 });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts().map((s) => s.getChildText('show'))).toEqual([null]);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status).toMatchObject({ busy: true, activeRuns: 1 });
    expect(h.status.lastOutboundAt).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts()).toHaveLength(1);
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status).toMatchObject({ busy: false, activeRuns: 0 });
    expect(h.status.lastOutboundAt).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts()).toHaveLength(1);
    expect(h.visible()).toHaveLength(2);
  });

  it('D6 consecutive authorized DM SDK runs stay available at start, processing, reply and end', async () => {
    const h = await fixture();
    expect(h.broadcasts().map((s) => s.getChildText('show'))).toEqual([null]);
    for (let run = 0; run < 3; run++) {
      const processing = deferred();
      h.dispatch.mockImplementationOnce(async () => {
        await processing.promise;
        await h.direct('D6-OK');
        return { queuedFinal: true };
      });
      h.inbound();
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.dispatch).toHaveBeenCalledTimes(run + 1);
      expect(h.status).toMatchObject({ busy: true, activeRuns: 1 });
      expect(h.broadcasts()).toHaveLength(1);
      processing.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.status).toMatchObject({ busy: false, activeRuns: 0, lastOutboundAt: Date.now() });
      expect(h.visible()).toHaveLength(run + 1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.broadcasts()).toHaveLength(1);
    }
  });

  describe.each(['adapter', 'callback'] as const)('late %s completion', (path) => {
    it.each([false, true])(
      'settling an old physical send after replacement, fails=%s',
      async (fails) => {
        const old = await fixture();
        const send = deferred();
        old.physical.mockImplementation(async (stanza) => {
          if (stanza.getChild('body')) await send.promise;
        });
        let result: Promise<string> | undefined;
        if (path === 'adapter')
          result = old.direct().then(
            () => 'sent',
            () => 'failed'
          );
        else {
          old.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: 'old' }, { kind: 'final' });
            return { queuedFinal: true };
          });
          old.inbound();
        }
        await vi.advanceTimersByTimeAsync(path === 'callback' ? 500 : 0);
        const current = await fixture();
        const oldStatus = { ...old.status };
        const currentStatus = { ...current.status };
        if (fails) send.reject(new Error('late old failure'));
        else send.resolve();
        if (result) expect(await result).toBe(fails ? 'failed' : 'sent');
        await vi.advanceTimersByTimeAsync(0);
        expect(old.status).toEqual(oldStatus);
        expect(current.status).toEqual(currentStatus);
        expect(current.physical).not.toHaveBeenCalled();
      }
    );
  });
});
