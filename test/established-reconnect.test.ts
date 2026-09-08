import { EventEmitter, getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xml, type Element } from '@xmpp/client';
import type { ChannelAccountSnapshot } from 'openclaw/plugin-sdk/channel-contract';
import type { GatewayStartContext, XmppConfig } from '../src/types.js';
import type { PluginRuntime } from 'openclaw/plugin-sdk/core';
import { getMucOccupantRealJid } from '../src/muc-identity.js';
import { setXmppRuntime } from '../src/runtime.js';

const mocks = vi.hoisted(() => ({ client: vi.fn(), joinMuc: vi.fn() }));
vi.mock('../src/xmpp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xmpp/client')>()),
  client: mocks.client,
}));
vi.mock('../src/rooms.js', () => ({ joinMuc: mocks.joinMuc }));

import { startXmppConnection } from '../src/monitor.js';
import {
  activeClients,
  accountLifecycles,
  clientDisposers,
  sentMessageIds,
  joinedRooms,
  pendingMucJoins,
  cleanupAccountState,
  keepaliveIntervals,
  reconnectStates,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
} from '../src/state.js';

// Keep the installed reconnect, middleware, resource binding and SM modules real.
// Only the transport and server responses are simulated; no network or sleeps.
type NativeClient = EventEmitter & {
  status: string;
  options: { service: string; domain: string };
  socket: TestTransport | { destroy(): void } | null;
  _attachSocket(socket: TestTransport): void;
  reconnect: { delay: number; stop(): void; scheduleReconnect(): void };
  streamManagement: EventEmitter & {
    enabled: boolean;
    enableSent: boolean;
    id: string;
    inbound: number;
    outbound: number;
    outbound_q: unknown[];
  };
  iqCaller: { set: (...args: unknown[]) => Promise<Element> };
  _status(status: string): void;
  _onElement(stanza: Element): void;
  connect(service: string): Promise<void>;
  open(options: { domain: string }): Promise<void>;
  disconnect(): Promise<void>;
  stop(): Promise<void>;
  send(stanza: Element): Promise<void>;
  sendMany(stanzas: Element[]): Promise<void>;
};

const accountId = 'established-test';
const rooms = ['room@conference.example.com'];
const require = createRequire(import.meta.url);
let controllers: AbortController[];
let clients: NativeClient[];
let lifetimes: Promise<void>[];

async function fixture(monitored: boolean | 'prepared' = true, config: Partial<XmppConfig> = {}) {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  const xmpp = actual.client({
    service: 'xmpp://example.com:5222',
    domain: 'example.com',
    username: 'bot',
    resource: 'test-resource',
  }) as unknown as NativeClient;
  clients.push(xmpp);
  let unavailable = false;
  let refuseResume = false;
  let holdEnable = false;
  let rosterFails = false;
  let rosterHeld = false;
  const attempts: number[] = [];
  const enabled = () =>
    xmpp._onElement(
      xml('enabled', { xmlns: 'urn:xmpp:sm:3', id: 'example-session', resume: 'true' })
    );
  const send = vi.spyOn(xmpp, 'send').mockImplementation(async (stanza) => {
    xmpp.emit('send', stanza); // Real SM outgoing counters and queue.
    await Promise.resolve(); // Responses follow procedure() listener registration.
    if (stanza.getChild('query', 'jabber:iq:roster') && stanza.attrs.type === 'get') {
      if (!rosterHeld)
        xmpp._onElement(
          xml(
            'iq',
            { type: rosterFails ? 'error' : 'result', id: stanza.attrs.id },
            xml('query', { xmlns: 'jabber:iq:roster' })
          )
        );
    }
    if (stanza.name === 'enable' && !holdEnable) enabled();
    if (stanza.name === 'resume') {
      xmpp._onElement(
        refuseResume
          ? xml('failed', { xmlns: 'urn:xmpp:sm:3' })
          : xml('resumed', { xmlns: 'urn:xmpp:sm:3', h: '3', previd: 'example-session' })
      );
    }
  });
  vi.spyOn(xmpp, 'sendMany').mockImplementation(async (stanzas) => {
    for (const stanza of stanzas) await xmpp.send(stanza);
  });
  vi.spyOn(xmpp.iqCaller, 'set').mockResolvedValue(
    xml('bind', {}, xml('jid', {}, 'bot@example.com/test-resource'))
  );
  const connect = vi.spyOn(xmpp, 'connect').mockImplementation(async () => {
    attempts.push(Date.now());
    xmpp._status('connecting');
    if (unavailable) {
      const error = new Error('ECONNREFUSED');
      xmpp.emit('error', error);
      xmpp._status('disconnect');
      throw error;
    }
    xmpp._status('connect');
  });
  const open = vi.spyOn(xmpp, 'open').mockImplementation(async () => {
    xmpp._status('open');
    xmpp._onElement(
      xml(
        'features',
        { xmlns: 'http://etherx.jabber.org/streams' },
        xml('sm', { xmlns: 'urn:xmpp:sm:3' }),
        xml('bind', { xmlns: 'urn:ietf:params:xml:ns:xmpp-bind' })
      )
    );
  });
  const nativeDisconnect = xmpp.disconnect.bind(xmpp);
  const disconnect = vi
    .spyOn(xmpp, 'disconnect')
    .mockImplementation(async () => xmpp._status('disconnect'));
  const stop = vi.spyOn(xmpp, 'stop').mockImplementation(async () => {
    await xmpp.disconnect();
    xmpp._status('offline');
  });
  const controller = new AbortController();
  controllers.push(controller);
  const status: Record<string, unknown> = {};
  const ctx: GatewayStartContext = {
    accountId,
    account: {
      accountId,
      enabled: true,
      config: { jid: 'bot@example.com', password: 'test-password', groups: rooms, ...config },
    },
    cfg: {},
    abortSignal: controller.signal,
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    setStatus: vi.fn((patch) => Object.assign(status, patch)),
    getStatus: () => ({ accountId, ...status }) as ChannelAccountSnapshot,
  };
  mocks.client.mockImplementation((options) => {
    xmpp.options.service = options.service;
    return xmpp;
  });
  mocks.joinMuc.mockResolvedValue(undefined);
  if (monitored === true) lifetimes.push(startXmppConnection(ctx));
  else if (monitored === false) {
    xmpp.on('error', () => {});
    await xmpp.connect(xmpp.options.service);
    await xmpp.open(xmpp.options);
  }
  await vi.advanceTimersByTimeAsync(10);
  attempts.length = 0;
  return {
    xmpp,
    connect,
    open,
    stop,
    disconnect,
    nativeDisconnect,
    send,
    controller,
    ctx,
    status,
    attempts,
    enabled,
    failRoster() {
      rosterFails = true;
    },
    holdRoster() {
      rosterHeld = true;
    },
    outage() {
      unavailable = true;
      xmpp._status('disconnect');
    },
    restore(fresh = false, pendingEnable = false) {
      unavailable = false;
      refuseResume = fresh;
      holdEnable = pendingEnable;
    },
  };
}

function holdOneCarbons(h: Awaited<ReturnType<typeof fixture>>) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const original = h.send.getMockImplementation()!;
  let held = false;
  h.send.mockImplementation(async (stanza) => {
    const hold = !held && Boolean(stanza.getChild('enable', 'urn:xmpp:carbons:2'));
    if (hold) held = true;
    await original(stanza); // Other writes, native SM and simulated server stay functional.
    if (hold) await promise;
  });
  return { resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  controllers = [];
  clients = [];
  lifetimes = [];
});

afterEach(async () => {
  for (const controller of controllers) controller.abort();
  await Promise.all(lifetimes);
  cleanupAccountState(accountId);
  for (const xmpp of clients) {
    xmpp.reconnect.stop();
    await xmpp.stop();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(keepaliveIntervals.size).toBe(0);
  expect(activeClients.size).toBe(0);
  expect(reconnectStates.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  for (const controller of controllers) {
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

class TestTransport extends EventEmitter {
  destroyed = false;
  end = vi.fn(() => this);
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('close');
  });
  write(_data: string, callback: () => void) {
    callback();
  }
}

function redirect(xmpp: NativeClient, host = 'redirect.example.com:5223') {
  xmpp._onElement(
    xml(
      'error',
      { xmlns: 'http://etherx.jabber.org/streams' },
      xml('see-other-host', { xmlns: 'urn:ietf:params:xml:ns:xmpp-streams' }, host)
    )
  );
}

describe('D5 presence with native SM and account lifecycle', () => {
  it('P2 Carbons: a pending optional write cannot gate ready presence, connected status or MUC', async () => {
    const h = await fixture('prepared', { presenceAllowFrom: ['alice@example.com'] });
    const pending = holdOneCarbons(h);
    try {
      lifetimes.push(startXmppConnection(h.ctx));
      await vi.advanceTimersByTimeAsync(20000);
      for (const type of ['subscribe', 'probe']) {
        h.xmpp._onElement(xml('presence', { from: 'alice@example.com/desktop', type }));
      }
      await vi.advanceTimersByTimeAsync(0);
      const stanzas = h.send.mock.calls.map(([s]) => s);
      expect({
        online: h.xmpp.status,
        smReady: h.xmpp.streamManagement.enabled,
        carbons: stanzas.filter((s) => s.getChild('enable', 'urn:xmpp:carbons:2')).length,
        roster: rosterGets(h).length,
        broadcasts: broadcasts(h).length,
        subscribed: stanzas.filter((s) => s.attrs.type === 'subscribed').length,
        directed: stanzas.filter(
          (s) => s.name === 'presence' && s.attrs.to === 'alice@example.com' && !s.attrs.type
        ).length,
        connected: h.status.connected === true,
        muc: mocks.joinMuc.mock.calls.length,
      }).toEqual({
        online: 'online',
        smReady: true,
        carbons: 1,
        roster: 1,
        broadcasts: 1,
        subscribed: 1,
        directed: 2,
        connected: true,
        muc: 1,
      });
    } finally {
      h.controller.abort();
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });
  it.each([
    ['resolve', false],
    ['reject', false],
    ['resolve', true],
    ['reject', true],
  ] as const)(
    'P2 Carbons: late %s is diagnostic only, even if logging throws=%s',
    async (outcome, throws) => {
      const h = await fixture('prepared');
      const pending = holdOneCarbons(h);
      lifetimes.push(startXmppConnection(h.ctx));
      await vi.advanceTimersByTimeAsync(20000);
      expect(h.status.connected).toBe(true);
      expect(carbons(h)).toHaveLength(1);
      expect(rosterGets(h)).toHaveLength(1);
      expect(broadcasts(h)).toHaveLength(1);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
      if (throws) {
        vi.mocked(h.ctx.log!.debug!).mockImplementation(() => {
          throw new Error('diagnostic failure');
        });
        vi.mocked(h.ctx.log!.warn!).mockImplementation(() => {
          throw new Error('diagnostic failure');
        });
      }
      h.status.lastError = 'Current account condition';
      const status = { ...h.status };
      const updates = vi.mocked(h.ctx.setStatus!).mock.calls.length;
      const sends = h.send.mock.calls.length;
      const timers = vi.getTimerCount();
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('optional write failure'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.status).toEqual(status);
      expect(h.ctx.setStatus).toHaveBeenCalledTimes(updates);
      expect(h.send).toHaveBeenCalledTimes(sends);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
      expect(h.stop).not.toHaveBeenCalled();
      expect(h.ctx.log?.error).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timers);
      // Keep unrelated shutdown diagnostics functional.
      vi.mocked(h.ctx.log!.debug!).mockImplementation(() => {});
      vi.mocked(h.ctx.log!.warn!).mockImplementation(() => {});
    }
  );
  it('P2 Carbons: real configured MUC joins finish while the optional write is still pending', async () => {
    const groups = ['first@conference.example.com', 'second@conference.example.com'];
    const h = await fixture('prepared', { groups });
    const pending = holdOneCarbons(h);
    const actualRooms = await vi.importActual<typeof import('../src/rooms.js')>('../src/rooms.js');
    mocks.joinMuc.mockImplementation(actualRooms.joinMuc);
    const original = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (stanza) => {
      await original(stanza);
      if (stanza.name === 'presence' && stanza.getChild('x', 'http://jabber.org/protocol/muc')) {
        h.xmpp._onElement(
          xml(
            'presence',
            { from: stanza.attrs.to },
            xml(
              'x',
              { xmlns: 'http://jabber.org/protocol/muc#user' },
              xml('item', { jid: 'agent@example.com/resource' }),
              xml('status', { code: '110' })
            )
          )
        );
      }
    });
    lifetimes.push(startXmppConnection(h.ctx));
    await vi.advanceTimersByTimeAsync(20000);
    expect(carbons(h)).toHaveLength(1);
    expect(broadcasts(h)).toHaveLength(1);
    expect(h.status.connected).toBe(true);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
    expect(joinedRooms.get(accountId)).toEqual(new Set(groups));
    expect(pendingMucJoins.size).toBe(0);
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(joinedRooms.has(accountId)).toBe(false);
  });
  it.each(['disconnect', 'abort', 'replacement', 'fresh'] as const)(
    'P2 Carbons: late success/failure after %s cannot touch the current lifecycle',
    async (action) => {
      for (const outcome of ['resolve', 'reject'] as const) {
        const h = await fixture('prepared');
        const pending = holdOneCarbons(h);
        lifetimes.push(startXmppConnection(h.ctx));
        await vi.advanceTimersByTimeAsync(20000);
        let current = h;
        if (action === 'abort') h.controller.abort();
        else if (action === 'replacement') current = await fixture();
        else {
          h.outage();
          if (action === 'fresh') {
            h.restore(true);
            await vi.advanceTimersByTimeAsync(1010);
            expect(carbons(h)).toHaveLength(2);
            expect(rosterGets(h)).toHaveLength(2);
            expect(broadcasts(h)).toHaveLength(2);
          }
        }
        await vi.advanceTimersByTimeAsync(0);
        current.status.lastError = 'Current generation condition';
        const status = { ...current.status };
        const updates = vi.mocked(current.ctx.setStatus!).mock.calls.length;
        const oldUpdates = vi.mocked(h.ctx.setStatus!).mock.calls.length;
        const diagnostics = [
          vi.mocked(h.ctx.log!.debug!).mock.calls.length,
          vi.mocked(h.ctx.log!.warn!).mock.calls.length,
        ];
        const counts = [
          h.send.mock.calls.length,
          mocks.joinMuc.mock.calls.length,
          h.connect.mock.calls.length,
          vi.getTimerCount(),
        ];
        if (outcome === 'resolve') pending.resolve();
        else pending.reject(new Error('old optional write failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(current.status).toEqual(status);
        expect(current.ctx.setStatus).toHaveBeenCalledTimes(updates);
        expect(h.ctx.setStatus).toHaveBeenCalledTimes(oldUpdates);
        expect([
          vi.mocked(h.ctx.log!.debug!).mock.calls.length,
          vi.mocked(h.ctx.log!.warn!).mock.calls.length,
        ]).toEqual(diagnostics);
        expect([
          h.send.mock.calls.length,
          mocks.joinMuc.mock.calls.length,
          h.connect.mock.calls.length,
          vi.getTimerCount(),
        ]).toEqual(counts);
        current.controller.abort();
        h.controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
      }
    }
  );
  it.each([false, true])(
    'P2 Carbons: native SM resume never repeats optional initialization, presence changed=%s',
    async (changed) => {
      const h = await fixture('prepared');
      const pending = holdOneCarbons(h);
      lifetimes.push(startXmppConnection(h.ctx));
      await vi.advanceTimersByTimeAsync(20000);
      h.outage();
      h.status.busy = changed;
      h.restore();
      await vi.advanceTimersByTimeAsync(1010);
      expect(h.xmpp.status).toBe('online');
      expect(carbons(h)).toHaveLength(1);
      expect(rosterGets(h)).toHaveLength(1);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
      expect(broadcasts(h)).toHaveLength(changed ? 2 : 1);
      const updates = vi.mocked(h.ctx.setStatus!).mock.calls.length;
      pending.reject(new Error('pre-resume optional write failure'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(carbons(h)).toHaveLength(1);
      expect(broadcasts(h)).toHaveLength(changed ? 2 : 1);
      expect(h.ctx.setStatus).toHaveBeenCalledTimes(updates);
      expect(h.status.lastError).toBeNull();
    }
  );
  it('P2 Carbons: six reloads with pending optional writes keep constant resources and inert old tasks', async () => {
    let expectedTimers: number | undefined;
    const retired: Array<{
      h: Awaited<ReturnType<typeof fixture>>;
      pending: ReturnType<typeof holdOneCarbons>;
    }> = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      const h = await fixture('prepared');
      const pending = holdOneCarbons(h);
      lifetimes.push(startXmppConnection(h.ctx));
      await vi.advanceTimersByTimeAsync(1000);
      expectedTimers ??= vi.getTimerCount();
      expect(expectedTimers).toBe(4); // Native SM request/deadline, keepalive and D5 poll; no Carbons timer.
      expect(vi.getTimerCount()).toBe(expectedTimers);
      await vi.advanceTimersByTimeAsync(19000);
      expect(vi.getTimerCount()).toBe(expectedTimers);
      expect(carbons(h)).toHaveLength(1);
      expect(rosterGets(h)).toHaveLength(1);
      expect(broadcasts(h)).toHaveLength(1);
      expect(h.status.connected).toBe(true);
      expect(accountLifecycles.size).toBe(1);
      expect(h.xmpp.listenerCount('stanza')).toBe(2);
      for (const old of retired) {
        expect(old.h.xmpp.listenerCount('stanza')).toBe(0);
        expect(old.h.xmpp.streamManagement.listenerCount('resumed')).toBe(0);
        expect(getEventListeners(old.h.controller.signal, 'abort')).toHaveLength(0);
      }
      retired.push({ h, pending });
    }
    retired.at(-1)!.h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    const counts = retired.map(({ h }) => h.send.mock.calls.length);
    for (const old of retired) old.pending.resolve();
    await vi.advanceTimersByTimeAsync(20000);
    expect(retired.map(({ h }) => h.send.mock.calls.length)).toEqual(counts);
    expect(vi.getTimerCount()).toBe(0);
    expect(activeClients.size).toBe(0);
  });
  const carbons = (h: Awaited<ReturnType<typeof fixture>>) =>
    h.send.mock.calls.map(([s]) => s).filter((s) => s.getChild('enable', 'urn:xmpp:carbons:2'));
  it('P2: native SM may replay a queued stanza without D5 creating an additional unresolved publication', async () => {
    const h = await fixture();
    let complete!: () => void;
    const original = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (stanza) => {
      await original(stanza); // Include this write in the installed SM queue.
      if (stanza.name === 'presence' && !stanza.attrs.to && !stanza.attrs.type && !complete) {
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
      }
    });
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(20000);
    expect(broadcasts(h)).toHaveLength(2);
    h.outage();
    h.status.busy = false;
    h.restore();
    await vi.advanceTimersByTimeAsync(1010);
    expect(h.xmpp.status).toBe('online');
    expect(broadcasts(h)).toHaveLength(3); // Initial, pending DND, native replay of that same DND.
    expect(h.xmpp.sendMany).toHaveBeenCalledExactlyOnceWith([broadcasts(h)[1]]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(broadcasts(h)).toHaveLength(3); // No D5 correction until application settlement.
    complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(broadcasts(h)).toHaveLength(4);
    expect(broadcasts(h)[3].getChildText('show')).toBeNull();
    expect(rosterGets(h)).toHaveLength(1);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
  });
  it('P2: native SM resume preserves an unresolved broadcast until physical settlement', async () => {
    const h = await fixture();
    let complete!: () => void;
    const original = h.send.getMockImplementation()!;
    h.send.mockImplementation((stanza) =>
      stanza.name === 'presence' && !stanza.attrs.to && !stanza.attrs.type && !complete
        ? new Promise<void>((resolve) => {
            complete = resolve;
          })
        : original(stanza)
    );
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(20000);
    expect(broadcasts(h)).toHaveLength(2);
    h.outage();
    h.status.busy = false;
    h.restore();
    await vi.advanceTimersByTimeAsync(1010);
    expect(h.xmpp.status).toBe('online');
    expect(broadcasts(h)).toHaveLength(2);
    expect(rosterGets(h)).toHaveLength(1);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(broadcasts(h)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(broadcasts(h)).toHaveLength(3);
    expect(broadcasts(h)[2].getChildText('show')).toBeNull();
    expect(vi.getTimerCount()).toBe(3); // Native SM ACK, keepalive and one D5 watcher.
  });
  it.each(['abort', 'reload', 'terminal'] as const)(
    'P2: late settlement after %s cannot restart presence',
    async (action) => {
      const h = await fixture();
      let complete!: () => void;
      const original = h.send.getMockImplementation()!;
      h.send.mockImplementation((stanza) =>
        stanza.name === 'presence' && !stanza.attrs.to && !stanza.attrs.type && !complete
          ? new Promise<void>((resolve) => {
              complete = resolve;
            })
          : original(stanza)
      );
      h.status.busy = true;
      await vi.advanceTimersByTimeAsync(20000);
      if (action === 'abort') h.controller.abort();
      else if (action === 'terminal') {
        reconnectStates.get(accountId)!.attempts = RECONNECT_MAX_ATTEMPTS;
        h.outage();
      } else await fixture();
      // Let the replacement's native SM debounce reach the same steady timer set.
      await vi.advanceTimersByTimeAsync(action === 'reload' ? 1000 : 0);
      const timers = vi.getTimerCount();
      const sends = h.send.mock.calls.length;
      complete();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.send.mock.calls).toHaveLength(sends);
      expect(vi.getTimerCount()).toBe(timers);
      expect(h.xmpp.listenerCount('stanza')).toBe(0);
      expect(h.xmpp.streamManagement.listenerCount('resumed')).toBe(0);
    }
  );
  it('acknowledges each roster push once through the native IQ dispatcher', async () => {
    const h = await fixture();
    h.xmpp._onElement(
      xml(
        'iq',
        { type: 'set', id: 'roster-push', from: 'bot@example.com' },
        xml(
          'query',
          { xmlns: 'jabber:iq:roster' },
          xml('item', { jid: 'alice@example.com', subscription: 'none' })
        )
      )
    );
    await vi.advanceTimersByTimeAsync(0);
    const replies = h.send.mock.calls.map(([s]) => s).filter((s) => s.attrs.id === 'roster-push');
    expect(replies).toHaveLength(1);
    expect(replies[0].attrs.type).toBe('result');
  });
  it('routes trusted subscriptions and probes through the current controller', async () => {
    const h = await fixture(true, { presenceAllowFrom: ['alice@example.com'] });
    h.status.busy = true;
    for (const type of ['subscribe', 'probe']) {
      h.xmpp._onElement(xml('presence', { from: 'alice@example.com/desktop', type }));
    }
    await vi.advanceTimersByTimeAsync(0);
    const directed = h.send.mock.calls
      .map(([s]) => s)
      .filter((s) => s.attrs.to === 'alice@example.com');
    expect(directed.filter((s) => s.attrs.type === 'subscribed')).toHaveLength(1);
    expect(directed.filter((s) => s.getChildText('show') === 'dnd')).toHaveLength(2);
  });
  it('abort during state derivation cannot publish a stale operational transition', async () => {
    const h = await fixture();
    h.ctx.getStatus = () => {
      h.controller.abort();
      return { accountId, busy: true };
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(broadcasts(h)).toHaveLength(1);
    expect(endings(h)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a replaced client cannot publish graceful unavailable on a newer lifecycle', async () => {
    const h = await fixture();
    const next = await fixture('prepared');
    activeClients.set(accountId, next.xmpp as never);
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(endings(h)).toHaveLength(0);
    expect(next.stop).not.toHaveBeenCalled();
    activeClients.delete(accountId);
  });
  const broadcasts = (h: Awaited<ReturnType<typeof fixture>>) =>
    h.send.mock.calls
      .map(([s]) => s)
      .filter((s) => s.name === 'presence' && !s.attrs.to && !s.attrs.type);
  const rosterGets = (h: Awaited<ReturnType<typeof fixture>>) =>
    h.send.mock.calls.filter(
      ([s]) => s.attrs.type === 'get' && s.getChild('query', 'jabber:iq:roster')
    );
  const endings = (h: Awaited<ReturnType<typeof fixture>>) =>
    h.send.mock.calls
      .map(([s]) => s)
      .filter((s) => s.name === 'presence' && s.attrs.type === 'unavailable');

  it.each([false, true])(
    'native resumed sends exactly one correction only if changed=%s',
    async (changed) => {
      const h = await fixture();
      expect(broadcasts(h)).toHaveLength(1);
      h.outage();
      h.status.busy = changed;
      await vi.advanceTimersByTimeAsync(1000);
      expect(broadcasts(h)).toHaveLength(1);
      h.restore();
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.xmpp.status).toBe('online');
      expect(broadcasts(h)).toHaveLength(changed ? 2 : 1);
      if (changed) expect(broadcasts(h)[1].getChildText('show')).toBe('dnd');
      expect(rosterGets(h)).toHaveLength(1);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
      expect(endings(h)).toHaveLength(0);
    }
  );
  it('fresh fallback reconciles once, republishes once and leaves one watcher', async () => {
    const h = await fixture();
    const timers = vi.getTimerCount();
    h.outage();
    h.restore(true);
    await vi.advanceTimersByTimeAsync(1010);
    expect(rosterGets(h)).toHaveLength(2);
    expect(broadcasts(h)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(timers);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
  });
  it.each(['refused', 'timeout'])(
    'roster %s suppresses global presence while messaging and MUC remain usable',
    async (failure) => {
      const h = await fixture('prepared');
      if (failure === 'refused') h.failRoster();
      else h.holdRoster();
      lifetimes.push(startXmppConnection(h.ctx));
      await vi.advanceTimersByTimeAsync(10);
      expect(h.status.connected).toBe(true);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
      const message = xml(
        'message',
        { to: 'alice@example.com', type: 'chat' },
        xml('body', {}, 'Hello')
      );
      await h.xmpp.send(message);
      expect(h.send).toHaveBeenCalledWith(message);
      await vi.advanceTimersByTimeAsync(5000);
      expect(broadcasts(h)).toHaveLength(0);
      expect(h.stop).not.toHaveBeenCalled();
    }
  );
  it.each(['abort', 'disable', 'cleanup'])(
    'deliberate %s sends one unavailable before closing',
    async (action) => {
      const h = await fixture(true, { presence: { mode: 'unavailable' } });
      const events: string[] = [];
      h.xmpp.on('send', (s) => {
        if (s.attrs.type === 'unavailable') events.push('unavailable');
      });
      h.stop.mockImplementation(async () => {
        events.push('stop');
        await h.xmpp.disconnect();
        h.xmpp._status('offline');
      });
      if (action === 'abort') h.controller.abort();
      else if (action === 'disable') {
        h.ctx.account.enabled = false;
        cleanupAccountState(accountId);
      } else cleanupAccountState(accountId);
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['unavailable', 'stop']);
      expect(endings(h)).toHaveLength(1);
      expect(broadcasts(h)[0].getChildText('show')).toBe('dnd');
      expect(h.xmpp.status).toBe('offline');
      expect(vi.getTimerCount()).toBe(0);
    }
  );
  it('bounds a wedged unavailable write to 250ms without reconnecting', async () => {
    const h = await fixture();
    h.send.mockImplementationOnce(() => new Promise<void>(() => {}));
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(249);
    expect(h.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not bypass pending SM readiness for a graceful stop after fresh fallback', async () => {
    const h = await fixture();
    h.outage();
    h.restore(true, true);
    await vi.advanceTimersByTimeAsync(1010);
    expect(h.xmpp.streamManagement.enabled).toBe(false);
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(endings(h)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('abrupt disconnect and terminal stop cannot send either DND or synthetic offline', async () => {
    const h = await fixture(true, { presence: { mode: 'available' } });
    h.outage();
    h.status.busy = true;
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(3000);
    expect(broadcasts(h)).toHaveLength(1);
    expect(endings(h)).toHaveLength(0);
  });
  it('six healthy account reloads keep constant live listeners/timers and retire all old state', async () => {
    let h = await fixture();
    const timers = vi.getTimerCount();
    const stanzaListeners = h.xmpp.listenerCount('stanza');
    expect(timers).toBe(3); // Native SM ACK, keepalive, operational presence.
    expect(stanzaListeners).toBe(2); // Messages and MUC/subscriptions; native IQ routes pushes.
    for (let i = 0; i < 6; i++) {
      const old = h;
      h = await fixture();
      expect(old.xmpp.listenerCount('stanza')).toBe(0);
      expect(old.xmpp.streamManagement.listenerCount('resumed')).toBe(0);
      expect(getEventListeners(old.controller.signal, 'abort')).toHaveLength(0);
      expect(clientDisposers.has(old.xmpp as never)).toBe(false);
      expect(h.xmpp.listenerCount('stanza')).toBe(stanzaListeners);
      expect(vi.getTimerCount()).toBe(timers);
      expect(accountLifecycles.size).toBe(1);
      expect(broadcasts(h)).toHaveLength(1);
      const count = old.send.mock.calls.length;
      old.status.busy = true;
      old.xmpp.streamManagement.emit('resumed');
      await vi.advanceTimersByTimeAsync(1000);
      expect(old.send.mock.calls.length).toBe(count);
    }
  });
  it('terminal exhaustion deactivates an active run tracker and all presence resources', async () => {
    const h = await fixture();
    const tracker = accountLifecycles.get(accountId)!.runState!;
    tracker.onRunStart();
    expect(h.status).toMatchObject({ busy: true, activeRuns: 1 });
    reconnectStates.get(accountId)!.attempts = RECONNECT_MAX_ATTEMPTS;
    h.outage();
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.isActive()).toBe(false);
    const statusCalls = vi.mocked(h.ctx.setStatus!).mock.calls.length;
    tracker.onRunEnd();
    expect(vi.mocked(h.ctx.setStatus!).mock.calls).toHaveLength(statusCalls);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.xmpp.listenerCount('stanza')).toBe(0);
  });
});

describe('established transport outage', () => {
  it('characterizes the installed 0.14.0 native fixed-delay reconnect loop', async () => {
    expect(require('@xmpp/client/package.json').version).toBe('0.14.0');
    expect(require('@xmpp/reconnect/package.json').version).toBe('0.14.0');
    const h = await fixture(false);
    expect(h.xmpp.reconnect.delay).toBe(1000);
    const start = Date.now();
    h.outage();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.attempts.map((at) => at - start)).toEqual([1000, 2000, 3000, 4000]);
    expect(reconnectStates.has(accountId)).toBe(false);
  });

  it('applies 1000/2000/4000/8000ms plugin backoff after an established disconnect', async () => {
    const h = await fixture();
    expect(h.status.connected).toBe(true);
    expect(h.xmpp.streamManagement.enabled).toBe(true);
    const start = Date.now();
    h.outage();
    await vi.advanceTimersByTimeAsync(15_000);
    expect.soft(reconnectStates.get(accountId)?.attempts).toBe(5);
    expect.soft(h.status.connected).toBe(false);
    expect
      .soft(h.ctx.log?.info)
      .toHaveBeenCalledWith(
        `[${accountId}] Scheduling reconnect in 8000ms (attempt 4/${RECONNECT_MAX_ATTEMPTS})`
      );
    expect(h.attempts.map((at) => at - start)).toEqual([1000, 3000, 7000, 15000]);
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 5,
      reconnectNextAt: start + 31000,
    });
    expect(reconnectStates.get(accountId)?.attempts).toBe(5);
    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('resumes the same SM session after failed retries without repeating initialization', async () => {
    const h = await fixture();
    const sm = h.xmpp.streamManagement;
    sm.inbound = 41;
    const resumed = vi.fn();
    sm.on('resumed', resumed);
    h.outage();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 3,
      lastError: 'ECONNREFUSED',
    });
    expect(sm.id).toBe('example-session');
    expect(sm.inbound).toBe(41);
    expect(sm.outbound_q).toHaveLength(3);
    h.restore();
    await vi.advanceTimersByTimeAsync(4000);
    expect(resumed).toHaveBeenCalledOnce(); // Emitted by the real SM module.
    expect(h.send.mock.calls.find(([stanza]) => stanza.name === 'resume')?.[0].attrs).toMatchObject(
      {
        previd: 'example-session',
        h: '41',
      }
    );
    expect(sm.inbound).toBe(41);
    expect(sm.outbound).toBe(3);
    expect(sm.outbound_q).toHaveLength(0);
    expect(sm.enabled).toBe(true);
    expect(h.xmpp.status).toBe('online');
    expect(h.status).toMatchObject({
      running: true,
      connected: true,
      reconnectAttempts: 0,
      reconnectNextAt: null,
      lastError: null,
    });
    expect(reconnectStates.get(accountId)).toMatchObject({ attempts: 0, nextDelayMs: 1000 });
    expect(reconnectStates.get(accountId)?.timer).toBeUndefined();
    expect(keepaliveIntervals.has(accountId)).toBe(true);
    expect(
      h.send.mock.calls.filter(
        ([stanza]) =>
          ['iq', 'presence'].includes(stanza.name) && !stanza.getChild('query', 'jabber:iq:roster')
      )
    ).toHaveLength(2);
    expect(mocks.joinMuc).toHaveBeenCalledExactlyOnceWith(
      h.xmpp,
      rooms[0],
      'bot',
      h.ctx.log,
      accountId,
      true,
      expect.any(AbortSignal)
    );
    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('falls back to fresh online and gates all application initialization on SM readiness', async () => {
    const h = await fixture();
    const sm = h.xmpp.streamManagement;
    h.outage();
    await vi.advanceTimersByTimeAsync(1000);
    h.restore(true, true);
    h.send.mockClear();
    mocks.joinMuc.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.xmpp.status).toBe('online'); // Resource binding precedes enable.
    expect(sm.enabled).toBe(false);
    expect(sm.enableSent).toBe(true);
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 2,
      reconnectNextAt: null,
    });
    expect(reconnectStates.get(accountId)?.attempts).toBe(2);
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    expect(h.send.mock.calls.map(([stanza]) => stanza.name)).toEqual(['resume', 'enable']);
    const message = xml('message', { to: 'friend@example.com' }, xml('body', {}, 'Hello'));
    const outbound = h.xmpp.send(message);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.send).not.toHaveBeenCalledWith(message);
    expect(mocks.joinMuc).not.toHaveBeenCalled();
    h.enabled();
    await vi.advanceTimersByTimeAsync(10);
    await outbound;
    expect(sm.enabled).toBe(true);
    expect(h.status).toMatchObject({
      connected: true,
      running: true,
      reconnectAttempts: 0,
      reconnectNextAt: null,
      lastError: null,
    });
    expect(keepaliveIntervals.has(accountId)).toBe(true);
    expect(
      h.send.mock.calls.some(([stanza]) => stanza.getChild('enable', 'urn:xmpp:carbons:2'))
    ).toBe(true);
    expect(h.send.mock.calls.some(([stanza]) => stanza.name === 'presence')).toBe(true);
    expect(mocks.joinMuc).toHaveBeenCalledExactlyOnceWith(
      h.xmpp,
      rooms[0],
      'bot',
      h.ctx.log,
      accountId,
      true,
      expect.any(AbortSignal)
    );
    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'rejected', 'wedged'])(
    'caps delays and exhausts all attempts with bounded terminal disposal: %s stop',
    async (mode) => {
      const h = await fixture();
      const nativeSchedule = vi.spyOn(h.xmpp.reconnect, 'scheduleReconnect');
      const destroy = vi.fn(() => {
        h.xmpp.socket = null;
      });
      h.outage();
      const recovery = reconnectStates.get(accountId)!;
      for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
        expect(reconnectStates.get(accountId)).toBe(recovery);
        expect(recovery.attempts).toBe(attempt);
        expect(h.status).toMatchObject({
          connected: false,
          reconnectAttempts: attempt,
          reconnectNextAt: Date.now() + delay,
        });
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(h.attempts).toHaveLength(attempt - 1);
        if (attempt === RECONNECT_MAX_ATTEMPTS) {
          h.xmpp.socket = { destroy };
          if (mode === 'rejected') h.stop.mockRejectedValueOnce(new Error('stop failed'));
          if (mode === 'wedged') h.stop.mockImplementationOnce(() => new Promise(() => {}));
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(h.attempts).toHaveLength(attempt);
      }
      expect(recovery).toMatchObject({
        aborted: true,
        attempts: RECONNECT_MAX_ATTEMPTS,
        timer: undefined,
        nextDelayMs: RECONNECT_MAX_DELAY_MS,
      });
      expect(h.status).toMatchObject({
        running: false,
        connected: false,
        terminalDisconnect: true,
        reconnectNextAt: null,
        lastError: 'Max reconnect attempts reached after 20 tries',
      });
      expect(activeClients.has(accountId)).toBe(false);
      expect(h.stop).toHaveBeenCalledOnce();
      // Only account lifetime completion remains; client and run tracker are disposed.
      expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(1);
      const lifetimeEnded = vi.fn();
      void lifetimes[0].then(lifetimeEnded);
      await vi.advanceTimersByTimeAsync(0);
      expect(lifetimeEnded).not.toHaveBeenCalled();
      expect(h.xmpp.streamManagement.listenerCount('resumed')).toBe(0);
      if (mode === 'wedged') {
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(4999);
        expect(destroy).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(destroy).toHaveBeenCalledOnce();
      expect(h.xmpp.socket).toBeNull();
      h.xmpp.emit('disconnect');
      h.xmpp.emit('offline');
      h.xmpp.streamManagement.emit('resumed');
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 2);
      expect(nativeSchedule).not.toHaveBeenCalled();
      expect(h.attempts).toHaveLength(RECONNECT_MAX_ATTEMPTS);
      expect(mocks.client).toHaveBeenCalledTimes(1);
      expect(h.status.running).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      if (mode === 'resolved') {
        // A new, explicit account start can recover after terminal exhaustion.
        const restarted = await fixture();
        expect(restarted.status).toMatchObject({
          running: true,
          connected: true,
          reconnectAttempts: 0,
        });
        expect(restarted.status.terminalDisconnect).toBeUndefined();
        expect(activeClients.get(accountId)).toBe(restarted.xmpp);
      }
    }
  );

  it.each(['abort', 'disable', 'reload'])(
    'cancels established backoff and ignores stale events after %s',
    async (mode) => {
      const h = await fixture();
      h.outage();
      await vi.advanceTimersByTimeAsync(500);
      if (mode === 'disable') {
        h.ctx.account.enabled = false;
        cleanupAccountState(accountId);
      }
      h.controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      const replacement = mode === 'reload' ? await fixture() : undefined;
      h.xmpp.emit('disconnect');
      h.xmpp.emit('offline');
      h.xmpp.streamManagement.emit('resumed');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.attempts).toHaveLength(0);
      expect(h.status.connected).toBe(false);
      expect(mocks.client).toHaveBeenCalledTimes(replacement ? 2 : 1);
      if (replacement) {
        expect(activeClients.get(accountId)).toBe(replacement.xmpp);
        expect(replacement.status.connected).toBe(true);
        expect(replacement.attempts).toHaveLength(0);
      } else expect(activeClients.has(accountId)).toBe(false);
    }
  );

  it('does not reconnect a replaced entity even before its abort signal arrives', async () => {
    const h = await fixture();
    h.outage();
    const replacement = await fixture();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.attempts).toHaveLength(0);
    expect(activeClients.get(accountId)).toBe(replacement.xmpp);
    expect(mocks.client).toHaveBeenCalledTimes(2);
  });

  it.each(['abort', 'replace'])(
    'cannot open a stale stream when %s happens during an in-flight reconnect',
    async (mode) => {
      const h = await fixture();
      h.outage();
      let finish!: () => void;
      h.connect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      await vi.advanceTimersByTimeAsync(1000);
      const opens = h.open.mock.calls.length;
      if (mode === 'abort') h.controller.abort();
      else await fixture();
      finish();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.open).toHaveBeenCalledTimes(opens);
      expect(h.connect).toHaveBeenCalledTimes(2);
    }
  );

  it('does not overlap retries while a disconnecting attempt is still settling', async () => {
    const h = await fixture();
    h.outage();
    let finish!: () => void;
    h.connect.mockImplementationOnce(async () => {
      h.xmpp._status('connecting');
      h.xmpp._status('disconnect');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error('ECONNREFUSED');
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(reconnectStates.get(accountId)?.attempts).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status).toMatchObject({ reconnectAttempts: 2, reconnectNextAt: Date.now() + 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.connect).toHaveBeenCalledTimes(3);
  });

  it('closes a failed stream open before retrying without clearing the resumable session', async () => {
    const h = await fixture();
    h.outage();
    h.restore();
    h.open.mockRejectedValueOnce(new Error('opening timed out'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.disconnect).toHaveBeenCalledOnce();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.xmpp.streamManagement.id).toBe('example-session');
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 2,
      lastError: 'opening timed out',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.status).toMatchObject({ connected: true, reconnectAttempts: 0, lastError: null });
    expect(mocks.client).toHaveBeenCalledTimes(1);
  });
});

describe('governed transport and lifecycle disposal', () => {
  it('destroys a captured socket when native disconnect detaches it after a close timeout', async () => {
    const h = await fixture();
    h.outage();
    h.restore();
    const socket = new TestTransport();
    h.connect.mockImplementationOnce(async () => {
      h.xmpp._attachSocket(socket);
      h.xmpp._status('connect');
    });
    h.open.mockRejectedValueOnce(new Error('stream failed'));
    h.disconnect.mockImplementationOnce(h.nativeDisconnect);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.end).toHaveBeenCalledOnce();
    expect(socket.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
    expect(h.xmpp.socket).toBeNull();
    expect(h.xmpp.streamManagement.id).toBe('example-session');
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.status.reconnectAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.status.connected).toBe(true);
    expect(mocks.client).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'replace'])(
    'disposes a transport attached after %s while connect is pending',
    async (mode) => {
      const h = await fixture();
      h.outage();
      const socket = new TestTransport();
      let finish!: () => void;
      h.connect.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        h.xmpp._attachSocket(socket);
        h.xmpp._status('connect');
      });
      await vi.advanceTimersByTimeAsync(1000);
      const opens = h.open.mock.calls.length;
      if (mode === 'abort') h.controller.abort();
      else await fixture();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.destroyed).toBe(true);
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(socket.end).not.toHaveBeenCalled();
      expect(h.open).toHaveBeenCalledTimes(opens);
      expect(h.xmpp.socket).toBeNull();
      expect(clientDisposers.has(h.xmpp as never)).toBe(false);
    }
  );

  it.each(['connect', 'open', 'disconnect'] as const)(
    'bounds a never-settling %s, disposes its socket and continues backoff with an isolated entity',
    async (operation) => {
      const h = await fixture();
      h.outage();
      h.restore();
      const socket = new TestTransport();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.connect.mockImplementationOnce(async () => {
        h.xmpp._attachSocket(socket);
        h.xmpp._status('connect');
        if (operation === 'connect') await pending;
      });
      if (operation === 'open') h.open.mockImplementationOnce(() => pending);
      if (operation === 'disconnect') {
        h.open.mockRejectedValueOnce(new Error('stream failed'));
        h.disconnect.mockImplementationOnce(() => {
          socket.end();
          return pending;
        });
      }
      const next = await fixture('prepared');
      const budget = operation === 'disconnect' ? 5000 : 2000;
      await vi.advanceTimersByTimeAsync(990 + budget - 1);
      expect(h.status.reconnectAttempts).toBe(1);
      expect(socket.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.destroyed).toBe(true);
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(h.status.reconnectAttempts).toBe(2);
      expect(h.status.reconnectNextAt).toBe(Date.now() + 2000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(activeClients.get(accountId)).toBe(next.xmpp);
      expect(h.status.connected).toBe(false); // Old monitor cannot report the new connection.
      await vi.advanceTimersByTimeAsync(10);
      const updates = h.ctx.setStatus.mock.calls.length;
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.ctx.setStatus.mock.calls.length).toBe(updates);
      expect(activeClients.get(accountId)).toBe(next.xmpp);
      expect(next.xmpp.status).toBe('online');
      expect(h.xmpp.socket).toBeNull();
      expect(clientDisposers.has(h.xmpp as never)).toBe(false);
    }
  );

  it('rejects a late post-timeout socket attachment without opening it or touching the replacement', async () => {
    const h = await fixture();
    h.outage();
    let finish!: () => void;
    const socket = new TestTransport();
    h.connect.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.xmpp._attachSocket(socket);
    });
    const next = await fixture('prepared');
    await vi.advanceTimersByTimeAsync(5000);
    expect(activeClients.get(accountId)).toBe(next.xmpp);
    const updates = h.ctx.setStatus.mock.calls.length;
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(socket.destroyed).toBe(true);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(activeClients.get(accountId)).toBe(next.xmpp);
    expect(h.ctx.setStatus.mock.calls.length).toBe(updates);
  });

  it('preserves a current-client see-other-host redirect and real SM resume without a plugin timer', async () => {
    const h = await fixture();
    const socket = new TestTransport();
    h.xmpp.socket = socket;
    const resumed = vi.fn();
    h.xmpp.streamManagement.on('resumed', resumed);
    redirect(h.xmpp);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.destroyed).toBe(true);
    expect(h.connect).toHaveBeenLastCalledWith('xmpp://redirect.example.com:5223');
    expect(resumed).toHaveBeenCalledOnce();
    expect(h.status).toMatchObject({
      connected: true,
      reconnectAttempts: 0,
      reconnectNextAt: null,
    });
    expect(h.ctx.log.info.mock.calls.some(([line]) => line.includes('Scheduling reconnect'))).toBe(
      false
    );
    expect(mocks.client).toHaveBeenCalledOnce();
    expect(mocks.joinMuc).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'disable', 'replacement'])(
    'prevents and disposes see-other-host after %s',
    async (mode) => {
      const h = await fixture();
      const socket = new TestTransport();
      h.xmpp.socket = socket;
      if (mode === 'abort') h.controller.abort();
      if (mode === 'disable') {
        h.ctx.account.enabled = false;
        cleanupAccountState(accountId);
      }
      const next = mode === 'replacement' ? await fixture() : undefined;
      redirect(h.xmpp);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(socket.destroyed).toBe(true);
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(activeClients.get(accountId)).toBe(next?.xmpp);
    }
  );

  it('transfers a failed redirect to exponential retry at the redirected service', async () => {
    const h = await fixture();
    h.connect.mockRejectedValueOnce(new Error('redirect refused'));
    redirect(h.xmpp);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 1,
      reconnectNextAt: Date.now() + 1000,
    });
    h.outage();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.connect).toHaveBeenLastCalledWith('xmpp://redirect.example.com:5223');
    expect(h.status.reconnectAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.connect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connect).toHaveBeenCalledTimes(4);
  });

  it('serializes a redirect close with an already scheduled retry', async () => {
    const h = await fixture();
    h.outage();
    h.restore();
    let finish!: () => void;
    h.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    redirect(h.xmpp);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.connect).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenLastCalledWith('xmpp://redirect.example.com:5223');
    expect(h.status.connected).toBe(true);
  });

  it('rejects all redirect/connection entry points after terminal exhaustion', async () => {
    const h = await fixture();
    reconnectStates.get(accountId)!.attempts = RECONNECT_MAX_ATTEMPTS;
    h.outage();
    await vi.advanceTimersByTimeAsync(0);
    redirect(h.xmpp);
    await expect(h.xmpp.connect('xmpp://redirect.example.com:5223')).rejects.toThrow('cancelled');
    await expect(h.xmpp.open(h.xmpp.options)).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.status).toMatchObject({ running: false, connected: false, terminalDisconnect: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes every old client across repeated failed replacements with constant account listeners', async () => {
    const h = await fixture();
    let old = h;
    for (let index = 0; index < 5; index++) {
      const next = await fixture('prepared');
      next.connect.mockRejectedValueOnce(new Error('startup refused'));
      old.xmpp.emit(
        'stanza',
        xml(
          'message',
          { from: 'bot@example.com/device', id: `client-${index}` },
          xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', id: `server-${index}` })
        )
      );
      expect(sentMessageIds.size).toBe(2);
      old.xmpp._status('offline'); // An unresumable session requires replacement.
      const delay = reconnectStates.get(accountId)!.nextDelayMs / 2;
      await vi.advanceTimersByTimeAsync(delay);
      expect(activeClients.get(accountId)).toBe(next.xmpp);
      expect(clientDisposers.has(old.xmpp as never)).toBe(false);
      expect(old.xmpp.listenerCount('stanza')).toBe(0);
      expect(old.xmpp.listenerCount('online')).toBe(0);
      expect(old.xmpp.listenerCount('error')).toBe(0);
      expect(old.xmpp.streamManagement.listenerCount('resumed')).toBe(0);
      expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(2);
      expect(accountLifecycles.size).toBe(1);
      expect(sentMessageIds.size).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      expect(accountLifecycles.get(accountId)?.disposeClient).toBe(
        clientDisposers.get(next.xmpp as never)
      );
      old = next;
    }
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(accountLifecycles.size).toBe(0);
    expect(clientDisposers.has(old.xmpp as never)).toBe(false);
  });

  it.each(['abort first', 'state first'])(
    'finishes disable with correct status and no retained lifecycle: %s',
    async (order) => {
      const h = await fixture();
      h.outage();
      if (order === 'abort first') {
        h.controller.abort();
        cleanupAccountState(accountId);
      } else {
        activeClients.delete(accountId); // Also tolerate host removal before invoking plugin cleanup.
        cleanupAccountState(accountId);
        h.controller.abort();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(h.status).toMatchObject({ running: false, connected: false, reconnectNextAt: null });
      expect(activeClients.size).toBe(0);
      expect(accountLifecycles.size).toBe(0);
      expect(reconnectStates.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const next = await fixture();
      const snapshot = { ...next.status };
      h.xmpp.emit('online', { toString: () => 'bot@example.com/old' });
      h.xmpp.emit('error', new Error('late failure'));
      redirect(h.xmpp);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(next.status).toEqual(snapshot);
      expect(h.connect).toHaveBeenCalledTimes(1);
    }
  );
});

describe('unfinished native negotiation cancellation', () => {
  it('releases native IQ deferreds and their 30-second timeout on abort', async () => {
    const h = await fixture();
    const iqCaller = h.xmpp.iqCaller as unknown as {
      request(stanza: Element): Promise<unknown>;
      handlers: Map<string, unknown>;
    };
    const reply = iqCaller.request(xml('iq', { type: 'get', id: 'pending-iq' }, xml('query')));
    const cancelled = expect(reply).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(iqCaller.handlers.size).toBe(1);
    h.controller.abort();
    await cancelled;
    await vi.advanceTimersByTimeAsync(0);
    expect(iqCaller.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot install an SM timer from an enabled response whose continuation runs after abort', async () => {
    const h = await fixture();
    h.outage();
    h.restore(true, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.xmpp.streamManagement.enableSent).toBe(true);
    h.enabled();
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.xmpp.streamManagement.enabled).toBe(false);
    expect(h.status).toMatchObject({ running: false, connected: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stream that never reaches online or resumed and continues plugin backoff', async () => {
    const h = await fixture();
    h.outage();
    h.restore();
    h.open.mockImplementationOnce(async () => {
      h.xmpp._status('open');
    });
    const next = await fixture('prepared');
    await vi.advanceTimersByTimeAsync(10_990);
    expect(h.status.reconnectAttempts).toBe(2);
    expect(h.status.reconnectNextAt).toBe(Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(2010);
    expect(activeClients.get(accountId)).toBe(next.xmpp);
    expect(h.status).toMatchObject({ connected: true, reconnectAttempts: 0 });
  });
});

describe('redirect cancellation while closing', () => {
  it.each(['abort', 'replacement'])(
    'cannot connect after %s during a pending redirect close',
    async (mode) => {
      const h = await fixture();
      const socket = new TestTransport();
      h.xmpp.socket = socket;
      let finish!: () => void;
      h.disconnect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      redirect(h.xmpp);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'abort') h.controller.abort();
      else await fixture();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.destroyed).toBe(true);
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(clientDisposers.has(h.xmpp as never)).toBe(false);
      if (mode === 'abort') expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('retains an initial-session redirect destination when a bounded operation requires replacement', async () => {
    const h = await fixture('prepared');
    const initialConnect = h.connect.getMockImplementation()!;
    h.connect
      .mockImplementationOnce(initialConnect)
      .mockImplementationOnce(() => new Promise(() => {}));
    h.open.mockImplementationOnce(async () => {
      redirect(h.xmpp);
    });
    lifetimes.push(startXmppConnection(h.ctx));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenLastCalledWith('xmpp://redirect.example.com:5223');
    expect(reconnectStates.get(accountId)?.attempts).toBe(0);
    const next = await fixture('prepared');
    await vi.advanceTimersByTimeAsync(1990); // Prepared fixture advanced 10ms; transport expires at 2s.
    expect(h.status).toMatchObject({ reconnectAttempts: 1, reconnectNextAt: Date.now() + 1000 });
    expect(mocks.client).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1010);
    expect(h.status.connected).toBe(true);
    expect(mocks.client.mock.calls.map(([options]) => options.service)).toEqual([
      'xmpp://example.com:5222',
      'xmpp://redirect.example.com:5223',
    ]);
    expect(activeClients.get(accountId)).toBe(next.xmpp);
  });
});

describe('R1 successive redirect policy', () => {
  it('bounds A -> B -> A -> B before a third immediate connection and enters backoff', async () => {
    const h = await fixture();
    h.open.mockImplementation(async () => {
      h.xmpp._status('open');
    });
    for (const host of ['b.example.com:5222', 'example.com:5222']) {
      redirect(h.xmpp, host);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.connect).toHaveBeenCalledTimes(3); // Initial connection plus two redirects.
    redirect(h.xmpp, 'b.example.com:5222');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connect).toHaveBeenCalledTimes(3);
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 1,
      reconnectNextAt: Date.now() + 1000,
    });
    expect(h.status.lastError).toMatch(/redirect.*limit|limit.*redirect/i);
    h.outage();
    const attempts = h.attempts.length;
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.attempts.slice(attempts).map((time) => time - start)).toEqual([1000, 3000, 7000]);
    expect(h.status.reconnectAttempts).toBe(4);
    expect(h.xmpp.options.domain).toBe('example.com');
    expect(mocks.client).toHaveBeenCalledOnce();
  });

  it.each([
    '',
    'redirect.example.com/path',
    'user@redirect.example.com',
    'xmpp://redirect.example.com',
    'redirect.example.com\n',
  ])(
    'sends malformed target %j to plugin backoff without an immediate connection',
    async (target) => {
      const h = await fixture();
      redirect(h.xmpp, target);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(h.status).toMatchObject({
        connected: false,
        reconnectAttempts: 1,
        reconnectNextAt: Date.now() + 1000,
      });
      h.outage();
      await vi.advanceTimersByTimeAsync(999);
      expect(h.connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.connect).toHaveBeenCalledTimes(2);
      expect(h.connect).toHaveBeenLastCalledWith('xmpp://example.com:5222');
      expect(h.status.reconnectAttempts).toBe(2);
    }
  );
});

describe('R1 redirect history lifecycle', () => {
  it.each(['resumed', 'fresh online'])(
    'resets history only after stable %s, preserving redirected-session initialization semantics',
    async (mode) => {
      const h = await fixture();
      if (mode === 'fresh online') h.restore(true);
      const resumed = vi.fn();
      h.xmpp.streamManagement.on('resumed', resumed);
      for (let cycle = 0; cycle < 3; cycle++) {
        h.open.mockImplementationOnce(async () => {
          h.xmpp._status('open');
        });
        redirect(h.xmpp, 'b.example.com:5222');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.status.connected).toBe(false);
        redirect(h.xmpp, 'example.com:5222');
        await vi.advanceTimersByTimeAsync(10);
        expect(h.status).toMatchObject({
          connected: true,
          reconnectAttempts: 0,
          reconnectNextAt: null,
        });
        expect(h.xmpp.streamManagement.enabled).toBe(true);
        expect(h.xmpp.options.domain).toBe('example.com');
        expect(h.connect).toHaveBeenCalledTimes(1 + (cycle + 1) * 2);
      }
      expect(resumed).toHaveBeenCalledTimes(mode === 'resumed' ? 3 : 0);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(mode === 'resumed' ? 1 : 4);
      expect(mocks.client).toHaveBeenCalledOnce();
    }
  );

  async function loop(h: Awaited<ReturnType<typeof fixture>>) {
    for (const host of ['b.example.com:5222', 'example.com:5222', 'b.example.com:5222']) {
      redirect(h.xmpp, host);
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  it('bounds every recovery attempt to two redirects and exhausts 20 scheduled attempts with no hidden connection', async () => {
    const h = await fixture();
    const nativeSchedule = vi.spyOn(h.xmpp.reconnect, 'scheduleReconnect');
    h.open.mockImplementation(async () => {
      h.xmpp._status('open');
    });
    await loop(h);
    expect(h.connect).toHaveBeenCalledTimes(3);
    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      expect(h.status).toMatchObject({
        reconnectAttempts: attempt,
        reconnectNextAt: Date.now() + delay,
      });
      const connections = h.connect.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.connect).toHaveBeenCalledTimes(connections);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.connect).toHaveBeenCalledTimes(connections + 1);
      await loop(h);
      expect(h.connect).toHaveBeenCalledTimes(connections + 3);
      expect(mocks.client).toHaveBeenCalledOnce();
    }
    expect(h.status).toMatchObject({
      running: false,
      connected: false,
      terminalDisconnect: true,
      reconnectNextAt: null,
    });
    expect(activeClients.has(accountId)).toBe(false);
    expect(h.connect).toHaveBeenCalledTimes(63); // Initial + 2 redirects; 20 × (attempt + 2 redirects).
    redirect(h.xmpp, 'b.example.com:5222');
    redirect(h.xmpp, 'invalid.example.com/path');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.connect).toHaveBeenCalledTimes(63);
    expect(nativeSchedule).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['abort', 'disable', 'replacement'])(
    'keeps %s final after redirect-limit failure schedules backoff',
    async (mode) => {
      const h = await fixture();
      h.open.mockImplementation(async () => {
        h.xmpp._status('open');
      });
      await loop(h);
      if (mode === 'abort') h.controller.abort();
      if (mode === 'disable') {
        h.ctx.account.enabled = false;
        cleanupAccountState(accountId);
      }
      const next = mode === 'replacement' ? await fixture() : undefined;
      redirect(h.xmpp, 'b.example.com:5222');
      redirect(h.xmpp, 'invalid.example.com/path');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.connect).toHaveBeenCalledTimes(3);
      expect(activeClients.get(accountId)).toBe(next?.xmpp);
      if (next) expect(next.status.connected).toBe(true);
      else expect(vi.getTimerCount()).toBe(0);
    }
  );
});

describe('R4 initial redirect ownership', () => {
  async function initialRedirect(holdOpen = false) {
    const h = await fixture('prepared');
    const first = new TestTransport();
    const second = new TestTransport();
    let finish!: (error?: Error) => void;
    h.connect
      .mockImplementationOnce(async () => {
        h.xmpp._attachSocket(first);
        h.xmpp._status('connect');
      })
      .mockImplementationOnce(async () => {
        h.xmpp._attachSocket(second);
        h.xmpp._status('connecting');
        await new Promise<void>((resolve, reject) => {
          finish = (error) => (error ? reject(error) : resolve());
        });
        h.xmpp._status('connect');
      });
    h.open.mockImplementationOnce(async () => h.xmpp._status('open'));
    if (holdOpen) h.open.mockImplementationOnce(async () => h.xmpp._status('open'));
    lifetimes.push(startXmppConnection(h.ctx));
    await vi.advanceTimersByTimeAsync(0);
    redirect(h.xmpp);
    await vi.advanceTimersByTimeAsync(0);
    return { ...h, first, second, finish };
  }

  const schedules = (h: Awaited<ReturnType<typeof fixture>>) =>
    vi
      .mocked(h.ctx.log!.info)
      .mock.calls.filter(([message]) => message.includes('Scheduling reconnect'));

  it('keeps a 1500ms initial redirect as the sole attempt, through real fresh SM readiness', async () => {
    const h = await initialRedirect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(schedules(h)).toHaveLength(0);
    expect(reconnectStates.get(accountId)?.attempts).toBe(0);
    expect(reconnectStates.get(accountId)?.timer).toBeUndefined();
    expect(mocks.client).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.first.destroyed).toBe(true);
    expect(h.second.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    h.finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.status).toMatchObject({
      connected: true,
      reconnectAttempts: 0,
      reconnectNextAt: null,
    });
    expect(h.xmpp.streamManagement.enabled).toBe(true);
    expect(schedules(h)).toHaveLength(0);
    expect(mocks.joinMuc).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenLastCalledWith('xmpp://redirect.example.com:5223');
    h.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.second.destroyed).toBe(true);
  });

  it('retains the redirected negotiation deadline after the initial waiter relinquishes ownership', async () => {
    const h = await initialRedirect(true);
    await vi.advanceTimersByTimeAsync(1500);
    h.finish();
    await vi.advanceTimersByTimeAsync(8499);
    expect(schedules(h)).toHaveLength(0);
    expect(h.second.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 1,
      reconnectNextAt: Date.now() + 1000,
    });
    expect(schedules(h)).toHaveLength(1);
    expect(h.second.destroyed).toBe(true);
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it('transfers a failed initial redirect exactly once to plugin attempt 1', async () => {
    const h = await initialRedirect();
    await vi.advanceTimersByTimeAsync(1500);
    h.finish(new Error('ECONNREFUSED'));
    await vi.advanceTimersByTimeAsync(0);
    expect(schedules(h)).toHaveLength(1);
    expect(h.status).toMatchObject({
      connected: false,
      reconnectAttempts: 1,
      reconnectNextAt: Date.now() + 1000,
    });
    expect(h.first.destroyed).toBe(true);
    expect(h.second.destroyed).toBe(true);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(mocks.client).toHaveBeenCalledOnce();
  });

  it.each(['malformed', 'redirect limit'])(
    'transfers initial %s failure exactly once to plugin backoff',
    async (mode) => {
      const h = await fixture('prepared');
      h.open.mockImplementation(async () => h.xmpp._status('open'));
      lifetimes.push(startXmppConnection(h.ctx));
      await vi.advanceTimersByTimeAsync(0);
      const targets =
        mode === 'malformed'
          ? ['invalid.example.com/path']
          : ['b.example.com', 'example.com', 'b.example.com'];
      for (const target of targets) {
        redirect(h.xmpp, target);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(h.connect).toHaveBeenCalledTimes(mode === 'malformed' ? 1 : 3);
      expect(schedules(h)).toHaveLength(1);
      expect(h.status).toMatchObject({ reconnectAttempts: 1, reconnectNextAt: Date.now() + 1000 });
    }
  );

  it.each(['abort', 'replacement'])(
    'makes %s final during an initial redirect, including late connect completion',
    async (mode) => {
      const h = await initialRedirect();
      await vi.advanceTimersByTimeAsync(500);
      if (mode === 'abort') h.controller.abort();
      const next = mode === 'replacement' ? await fixture() : undefined;
      h.finish();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.first.destroyed).toBe(true);
      expect(h.second.destroyed).toBe(true);
      expect(h.connect).toHaveBeenCalledTimes(2);
      expect(h.open).toHaveBeenCalledTimes(1);
      expect(schedules(h)).toHaveLength(0);
      expect(activeClients.get(accountId)).toBe(next?.xmpp);
      if (next) expect(next.status.connected).toBe(true);
      else expect(vi.getTimerCount()).toBe(0);
    }
  );
});

describe('R5 MUC identity across logical sessions', () => {
  const room = rooms[0];
  const nick = 'SomeNick';
  const realJid = 'allowed-user@example.com';
  function presence(h: Awaited<ReturnType<typeof fixture>>, jid?: string) {
    h.xmpp._onElement(
      xml(
        'presence',
        { from: `${room}/${nick}` },
        xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, xml('item', jid ? { jid } : {}))
      )
    );
  }
  async function mucFixture() {
    const h = await fixture();
    h.ctx.account.config.groupAllowFrom = [realJid];
    const dispatch = vi.fn(async () => ({ queuedFinal: false }));
    setXmppRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({ agentId: 'agent', sessionKey: 'session', accountId }),
        },
        session: {
          resolveStorePath: () => '/tmp/example-xmpp-sessions.json',
          recordInboundSession: async () => {},
        },
        reply: {
          finalizeInboundContext: (context: unknown) => context,
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
        },
      },
    } as unknown as PluginRuntime);
    joinedRooms.set(accountId, new Set([room]));
    presence(h, realJid);
    await vi.advanceTimersByTimeAsync(0);
    expect(getMucOccupantRealJid(accountId, room, nick)).toBe(realJid);
    const message = async () => {
      h.xmpp._onElement(
        xml(
          'message',
          { from: `${room}/${nick}`, to: 'bot@example.com', type: 'groupchat', id: 'muc-message' },
          xml('body', {}, 'hello')
        )
      );
      await vi.advanceTimersByTimeAsync(0);
    };
    await message();
    expect(dispatch).toHaveBeenCalledOnce();
    dispatch.mockClear();
    return { ...h, message, dispatch };
  }

  it('clears old joins, pending joins and verified identities at fresh online, failing closed until new presence', async () => {
    const h = await mucFixture();
    h.outage();
    const pending = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 60_000) };
    pendingMucJoins.set(`${accountId}:${room}`, pending);
    h.restore(true, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.xmpp.streamManagement.enableSent).toBe(true);
    expect(getMucOccupantRealJid(accountId, room, nick)).toBeUndefined();
    expect(joinedRooms.has(accountId)).toBe(false);
    expect(pendingMucJoins.has(`${accountId}:${room}`)).toBe(false);
    expect(pending.resolve).toHaveBeenCalledOnce();
    expect(mocks.joinMuc).toHaveBeenCalledOnce(); // Fresh readiness is still pending.
    await h.message();
    expect(h.dispatch).not.toHaveBeenCalled();
    h.enabled();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.status.connected).toBe(true);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
    expect(joinedRooms.has(accountId)).toBe(false); // No new self-presence/join confirmation yet.
    await h.message();
    expect(h.dispatch).not.toHaveBeenCalled();
    presence(h); // Anonymous presence must remain fail-closed.
    await h.message();
    expect(h.dispatch).not.toHaveBeenCalled();
    presence(h, realJid);
    await h.message();
    expect(getMucOccupantRealJid(accountId, room, nick)).toBe(realJid);
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(mocks.client).toHaveBeenCalledOnce();
  });

  it('retains joined rooms and verified identities on real SM resumption without a MUC rejoin', async () => {
    const h = await mucFixture();
    const oldRooms = joinedRooms.get(accountId);
    h.outage();
    h.restore();
    await vi.advanceTimersByTimeAsync(1010);
    expect(h.status.connected).toBe(true);
    expect(getMucOccupantRealJid(accountId, room, nick)).toBe(realJid);
    expect(joinedRooms.get(accountId)).toBe(oldRooms);
    expect(mocks.joinMuc).toHaveBeenCalledOnce();
    await h.message();
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(mocks.client).toHaveBeenCalledOnce();
  });
});
