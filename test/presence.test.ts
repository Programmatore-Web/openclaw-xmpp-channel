import { EventEmitter } from 'node:events';
import { xml, type Element, type XmppClient } from '@xmpp/client';
import type { ChannelAccountSnapshot } from 'openclaw/plugin-sdk/channel-contract';
import type { PluginRuntime } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPresenceController,
  derivePresence,
  buildOperationalPresence,
} from '../src/presence.js';
import { setXmppRuntime } from '../src/runtime.js';
import type { XmppConfig, GatewayStartContext } from '../src/types.js';

const alice = 'alice@example.com';
const accountId = 'presence-test';
const disposers: Array<() => void> = [];
let pairing: ReturnType<typeof vi.fn>;

function deferredWrite() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<XmppConfig> = {}) {
  const emitter = new EventEmitter();
  const status: ChannelAccountSnapshot = { accountId };
  const config = { jid: 'agent@example.com', password: 'test-only', ...overrides };
  let connected = true;
  let current = true;
  let items: Element[] = [];
  let rosterMode: 'ok' | 'error' | 'missing' | 'hang' | 'unconfirmed' = 'ok';
  const send = vi.fn(async (stanza: Element) => {
    if (stanza.attrs.type === 'unsubscribed' && rosterMode !== 'unconfirmed') {
      items = items.filter((item) => item.attrs.jid !== stanza.attrs.to);
    }
    if (stanza.getChild('query', 'jabber:iq:roster') && stanza.attrs.type === 'get') {
      if (rosterMode === 'hang') return;
      emitter.emit(
        'stanza',
        xml(
          'iq',
          {
            type: rosterMode === 'error' ? 'error' : 'result',
            id: stanza.attrs.id,
          },
          ...(rosterMode === 'missing'
            ? []
            : [xml('query', { xmlns: 'jabber:iq:roster' }, ...items)])
        )
      );
    }
  });
  const ctx: GatewayStartContext = {
    accountId,
    account: { accountId, enabled: true, config },
    cfg: {},
    getStatus: () => status,
    log: { warn: vi.fn() },
  };
  const controller = createPresenceController({
    xmpp: emitter as unknown as XmppClient,
    ctx,
    send,
    isCurrent: () => current,
    isOnline: () => connected,
  });
  disposers.push(controller.dispose);
  const presence = () => send.mock.calls.map(([s]) => s).filter((s) => s.name === 'presence');
  return {
    controller,
    ctx,
    config,
    status,
    send,
    emitter,
    presence,
    broadcasts: () => presence().filter((s) => !s.attrs.to),
    roster(itemsValue: Element[], mode = rosterMode) {
      items = itemsValue;
      rosterMode = mode;
    },
    disconnect() {
      connected = false;
      controller.suspend();
    },
    reconnect() {
      connected = true;
    },
    replace() {
      current = false;
    },
  };
}

/** Audit the installed send/write path: bytes enter socket.write synchronously,
 * independently of when its completion callbacks (and send Promises) settle. */
async function nativeWire(h: ReturnType<typeof fixture>) {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  const native = actual.client({
    service: 'xmpp://example.com:5222',
    domain: 'example.com',
    username: 'agent',
  }) as unknown as {
    status: string;
    Transport: unknown;
    _findTransport(service: string): unknown;
    socket: { write(data: string, callback: (error?: Error) => void): void } | null;
    reconnect: { stop(): void };
    send(stanza: Element): Promise<void>;
  };
  const writes: Array<{ data: string; complete: (error?: Error) => void }> = [];
  native.Transport = native._findTransport('xmpp://example.com:5222');
  native.status = 'online';
  native.socket = {
    write: (data, complete) => {
      writes.push({ data, complete });
    },
  };
  disposers.push(() => {
    native.reconnect.stop();
    native.socket = null;
  });
  const original = h.send.getMockImplementation()!;
  h.send.mockImplementation((stanza) =>
    stanza.getChild('query', 'jabber:iq:roster') && stanza.attrs.type === 'get'
      ? original(stanza)
      : native.send(stanza)
  );
  return writes;
}

beforeEach(() => {
  vi.useFakeTimers();
  pairing = vi.fn().mockResolvedValue([]);
  setXmppRuntime({
    channel: {
      pairing: {
        readAllowFromStore: pairing,
        upsertPairingRequest: () => {
          throw new Error('Presence must never create pairing requests');
        },
      },
    },
  } as unknown as PluginRuntime);
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    dispose();
    dispose();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('Thunderbird mapping and exact SDK snapshot', () => {
  it.each([
    [{ busy: false }, 'available'],
    [{ activeRuns: 0 }, 'available'],
    [{ busy: true }, 'unavailable'],
    [{ activeRuns: 2 }, 'unavailable'],
    [{ ingressUnavailable: true }, 'unavailable'],
    [{ lifecycle: 'blocked' }, 'unavailable'],
  ] as const)('derives %j as %s', (snapshot, state) => {
    const result = derivePresence(undefined, { accountId, ...snapshot });
    expect(result.state).toBe(state);
    const stanza = buildOperationalPresence(result);
    expect(stanza.attrs.type).toBeUndefined();
    expect(stanza.getChildText('priority')).toBe('1');
    expect(stanza.getChildText('show')).toBe(state === 'unavailable' ? 'dnd' : null);
  });
  it.each(['available', 'unavailable'] as const)('forces %s while connected', async (mode) => {
    const h = fixture({ presence: { mode } });
    h.status.busy = mode === 'available';
    await h.controller.ready(true);
    expect(h.broadcasts()).toHaveLength(1);
    expect(h.broadcasts()[0].getChildText('show')).toBe(mode === 'unavailable' ? 'dnd' : null);
    h.disconnect();
    await h.controller.ready(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts()).toHaveLength(1);
  });
  it('publishes only configured safe text, with XML escaping', async () => {
    const h = fixture({ presence: { availableText: 'Ready <&>', unavailableText: 'Busy' } });
    Object.assign(h.status, { lastError: 'PRIVATE_EXCEPTION', stateReason: 'PRIVATE_PROVIDER' });
    await h.controller.ready(true);
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.broadcasts().map((s) => s.getChildText('status'))).toEqual(['Ready <&>', 'Busy']);
    expect(h.broadcasts().map(String).join()).not.toContain('PRIVATE_');
    expect(String(h.broadcasts()[0])).toContain('&lt;&amp;&gt;');
  });
});

describe('deduplication and session ownership', () => {
  it('P2: keeps a timed-out physical broadcast serialized across repeated poll ticks', async () => {
    const h = fixture();
    const originalSend = h.send.getMockImplementation()!;
    h.send.mockImplementation((stanza) => {
      if (stanza.name === 'presence' && !stanza.attrs.to) {
        return new Promise<void>(() => {});
      }
      return originalSend(stanza);
    });
    const ready = h.controller.ready(true);
    const counts: number[] = [];
    for (const elapsed of [5000, 1000, 4000, 10000]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      counts.push(h.broadcasts().length);
    }
    await ready;
    expect(counts).toEqual([1, 1, 1, 1]); // At 5s, 6s, 10s and 20s.
  });
  it('publishes one initial, one DND, one available, and one text correction', async () => {
    const h = fixture();
    await h.controller.ready(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.broadcasts()).toHaveLength(1);
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.broadcasts()).toHaveLength(2);
    h.status.busy = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.broadcasts()).toHaveLength(3);
    h.config.presence = { availableText: 'Ready' };
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.broadcasts()).toHaveLength(4);
    expect(h.broadcasts().map((s) => s.getChildText('show'))).toEqual([null, 'dnd', null, null]);
  });
  it.each([false, true])('SM resume corrects only a changed state (%s)', async (changed) => {
    const h = fixture();
    await h.controller.ready(true);
    h.disconnect();
    h.status.busy = changed;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts()).toHaveLength(1);
    h.reconnect();
    await h.controller.ready(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts()).toHaveLength(changed ? 2 : 1);
    expect(h.send.mock.calls.filter(([s]) => s.name === 'iq')).toHaveLength(1);
  });
  it('fresh fallback reconciles and publishes again, clearing old deduplication', async () => {
    const h = fixture();
    await h.controller.ready(true);
    h.disconnect();
    h.reconnect();
    h.controller.reset();
    await h.controller.ready(true);
    expect(h.broadcasts()).toHaveLength(2);
    expect(h.send.mock.calls.filter(([s]) => s.name === 'iq')).toHaveLength(2);
  });
  it.each(['disconnect', 'replace', 'dispose'] as const)(
    'never publishes after %s during authorization',
    async (action) => {
      const h = fixture();
      await h.controller.ready(true);
      let resolve!: (value: string[]) => void;
      pairing.mockReturnValue(
        new Promise<string[]>((r) => {
          resolve = r;
        })
      );
      const pending = h.controller.handle('subscribe', alice);
      if (action === 'dispose') h.controller.dispose();
      else h[action]();
      resolve([alice]);
      await pending;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.presence()).toHaveLength(1);
    }
  );
  it('does not overlap broadcasts while a transition write is pending', async () => {
    const h = fixture();
    await h.controller.ready(true);
    let resolve!: () => void;
    h.send.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        })
    );
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts()).toHaveLength(2);
    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.broadcasts()).toHaveLength(2);
  });
  it('disposes pending roster IO, all listeners and timers over six replacements', async () => {
    for (let i = 0; i < 6; i++) {
      const h = fixture();
      h.roster([], 'hang');
      const ready = h.controller.ready(true);
      expect(h.emitter.listenerCount('stanza')).toBe(2);
      h.controller.dispose();
      await ready;
      expect(h.emitter.listenerCount('stanza')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.broadcasts()).toHaveLength(0);
    }
  });
});

describe('P2 physical publication ownership', () => {
  it.each([false, true])(
    'coalesces late success to the latest state/text (initial busy=%s)',
    async (busy) => {
      const h = fixture();
      h.status.busy = busy;
      const pending = deferredWrite();
      const original = h.send.getMockImplementation()!;
      h.send.mockImplementationOnce(original).mockImplementationOnce(() => pending.promise);
      const ready = h.controller.ready(true);
      await vi.advanceTimersByTimeAsync(1000);
      h.status.busy = !busy;
      h.config.presence = { availableText: 'Latest ready', unavailableText: 'Latest busy' };
      await vi.advanceTimersByTimeAsync(19000);
      await ready;
      expect(h.broadcasts()).toHaveLength(1);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.broadcasts()).toHaveLength(2);
      expect(h.broadcasts()[1].getChildText('show')).toBe(busy ? null : 'dnd');
      expect(h.broadcasts()[1].getChildText('status')).toBe(busy ? 'Latest ready' : 'Latest busy');
      await vi.advanceTimersByTimeAsync(20000);
      expect(h.broadcasts()).toHaveLength(2); // Latest successful publication is remembered.
    }
  );
  it('drops intermediate changes that return to the physically pending value', async () => {
    const h = fixture();
    await h.controller.ready(true);
    const pending = deferredWrite();
    h.send.mockImplementationOnce(() => pending.promise);
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(1000);
    h.status.busy = false;
    await vi.advanceTimersByTimeAsync(7000);
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.broadcasts()).toHaveLength(2);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.broadcasts()).toHaveLength(2);
  });
  it('contains late failure and retries only on a subsequent poll, never recursively', async () => {
    const h = fixture();
    await h.controller.ready(true);
    const pending = deferredWrite();
    h.send.mockImplementationOnce(() => pending.promise);
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.broadcasts()).toHaveLength(2);
    pending.reject(new Error('test late rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.broadcasts()).toHaveLength(2);
    h.send.mockRejectedValueOnce(new Error('test retry rejection'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.broadcasts()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.broadcasts()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.broadcasts()).toHaveLength(4);
  });
  it.each(['dispose', 'replace'] as const)(
    'late completion after %s cannot publish or revive resources',
    async (action) => {
      const h = fixture();
      await h.controller.ready(true);
      const pending = deferredWrite();
      h.send.mockImplementationOnce(() => pending.promise);
      h.status.busy = true;
      await vi.advanceTimersByTimeAsync(1000);
      h.status.busy = false;
      if (action === 'dispose') h.controller.dispose();
      else h.replace();
      await vi.advanceTimersByTimeAsync(20000);
      expect(vi.getTimerCount()).toBe(0);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.broadcasts()).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      h.controller.dispose();
      expect(h.emitter.listenerCount('stanza')).toBe(0);
    }
  );
  it.each(['resolve', 'reject'] as const)(
    'an old fresh-session %s cannot release the new physical lock',
    async (outcome) => {
      const h = fixture();
      await h.controller.ready(true);
      const old = deferredWrite();
      h.send.mockImplementationOnce(() => old.promise);
      h.status.busy = true;
      await vi.advanceTimersByTimeAsync(1000);
      h.disconnect();
      h.controller.reset();
      h.reconnect();
      const next = deferredWrite();
      const original = h.send.getMockImplementation()!;
      h.send.mockImplementationOnce(original).mockImplementationOnce(() => next.promise);
      const ready = h.controller.ready(true);
      await vi.advanceTimersByTimeAsync(6000);
      await ready;
      h.status.busy = false;
      if (outcome === 'resolve') old.resolve();
      else old.reject(new Error('old stream failure'));
      await vi.advanceTimersByTimeAsync(20000);
      expect(h.broadcasts()).toHaveLength(3);
      next.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.broadcasts()).toHaveLength(4);
      expect(h.broadcasts()[3].getChildText('show')).toBeNull();
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.broadcasts()).toHaveLength(4);
    }
  );
  it.each([false, true])(
    'SM resume preserves the physical barrier and corrects only changed=%s',
    async (changed) => {
      const h = fixture();
      const pending = deferredWrite();
      const original = h.send.getMockImplementation()!;
      h.send.mockImplementationOnce(original).mockImplementationOnce(() => pending.promise);
      const ready = h.controller.ready(true);
      await vi.advanceTimersByTimeAsync(1000);
      h.disconnect();
      await ready;
      h.status.busy = changed;
      h.reconnect();
      await h.controller.ready(false);
      await vi.advanceTimersByTimeAsync(20000);
      expect(h.broadcasts()).toHaveLength(1);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.broadcasts()).toHaveLength(1); // Old generation callback cannot schedule a correction.
      await vi.advanceTimersByTimeAsync(1000); // The current publisher consumes the outcome.
      expect(h.broadcasts()).toHaveLength(changed ? 2 : 1);
      expect(h.send.mock.calls.filter(([s]) => s.name === 'iq')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.broadcasts()).toHaveLength(changed ? 2 : 1);
    }
  );
  it('a never-settling physical send retains one slot and constant resources for an hour', async () => {
    const h = fixture();
    await h.controller.ready(true);
    const pending = deferredWrite();
    h.send.mockImplementationOnce(() => pending.promise);
    h.status.busy = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(2); // Poll plus one wait budget.
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(1); // Only polling, no repeated budgets/writes.
    await vi.advanceTimersByTimeAsync(3600000);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.broadcasts()).toHaveLength(2); // Initial plus exactly one pending transition.
    expect(h.ctx.log?.warn).toHaveBeenCalledTimes(1);
    h.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.emitter.listenerCount('stanza')).toBe(0);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.broadcasts()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('trusted subscriptions and probes', () => {
  it('unsubscribe cancels a pending approval and duplicate in-flight subscribe is coalesced', async () => {
    const h = fixture();
    await h.controller.ready(true);
    h.send.mockClear();
    let resolve!: (value: string[]) => void;
    pairing.mockReturnValue(
      new Promise<string[]>((r) => {
        resolve = r;
      })
    );
    const approval = h.controller.handle('subscribe', alice);
    await h.controller.handle('subscribe', alice);
    expect(pairing).toHaveBeenCalledTimes(1);
    await h.controller.handle('unsubscribe', alice);
    resolve([alice]);
    await approval;
    expect(h.presence().map((s) => s.attrs.type)).toEqual(['unsubscribed']);
  });
  it.each([
    ['unknown', {}, false],
    ['open DM', { dmPolicy: 'open' }, false],
    ['group allowlist', { groupAllowFrom: [alice] }, false],
    ['DM allowlist', { dmPolicy: 'allowlist', dmAllowlist: [alice] }, false],
    ['owner wildcard', { allowFrom: ['*'] }, false],
    ['owner', { allowFrom: [alice] }, true],
    ['presence list', { presenceAllowFrom: [alice] }, true],
    ['explicit public presence', { presenceAllowFrom: ['*'] }, true],
  ] as Array<[string, Partial<XmppConfig>, boolean]>)(
    '%s: authorized=%s',
    async (_name, config, allowed) => {
      const h = fixture(config);
      h.status.busy = true;
      await h.controller.ready(true);
      h.send.mockClear();
      await h.controller.handle('subscribe', `${alice}/desktop`);
      expect(h.presence()).toHaveLength(allowed ? 2 : 0);
      if (allowed) {
        expect(h.presence()[0].attrs).toEqual({ to: alice, type: 'subscribed' });
        expect(h.presence()[1].attrs).toEqual({ to: alice });
        expect(h.presence()[1].getChildText('show')).toBe('dnd');
      }
      h.send.mockClear();
      await h.controller.handle('probe', alice);
      expect(h.presence()).toHaveLength(allowed ? 1 : 0);
      if (allowed) expect(h.presence()[0].getChildText('show')).toBe('dnd');
    }
  );
  it('uses account-scoped existing pairing even when DM policy is disabled', async () => {
    const h = fixture({ dmPolicy: 'disabled' });
    pairing.mockResolvedValue([alice]);
    await h.controller.ready(true);
    h.send.mockClear();
    await h.controller.handle('subscribe', alice);
    expect(pairing).toHaveBeenCalledWith({ channel: 'xmpp', accountId });
    expect(h.presence()).toHaveLength(2);
  });
  it.each(['subscribe', 'probe'])(
    'pairing-store failure denies %s with no exception disclosure',
    async (type) => {
      const h = fixture();
      await h.controller.ready(true);
      h.send.mockClear();
      pairing.mockRejectedValue(new Error('PRIVATE_SECRET'));
      await h.controller.handle(type, alice);
      expect(h.presence()).toHaveLength(0);
      expect(JSON.stringify(h.ctx.log)).not.toContain('PRIVATE_SECRET');
    }
  );
  it('probe derives current state immediately without waiting for the next poll', async () => {
    const h = fixture({ presenceAllowFrom: [alice] });
    await h.controller.ready(true);
    h.status.busy = true;
    await h.controller.handle('probe', alice);
    expect(h.presence().at(-1)?.getChildText('show')).toBe('dnd');
    expect(h.broadcasts()).toHaveLength(1);
  });
  it('acknowledges unsubscribe without retaining any local subscriber', async () => {
    const h = fixture();
    await h.controller.ready(true);
    h.send.mockClear();
    await h.controller.handle('unsubscribe', alice);
    expect(h.presence().map((s) => s.attrs)).toEqual([{ to: alice, type: 'unsubscribed' }]);
    await h.controller.handle('probe', alice);
    expect(h.presence()).toHaveLength(1);
  });
});

describe('P2 audit of one-shot bounded D5 writes', () => {
  it.each(['resolve', 'reject'] as const)(
    'a timed-out roster write/result cannot reopen reconciliation after late %s',
    async (outcome) => {
      const h = fixture();
      const pending = deferredWrite();
      h.send.mockImplementationOnce(() => pending.promise);
      const ready = h.controller.ready(true);
      const id = h.send.mock.calls[0][0].attrs.id;
      expect(h.emitter.listenerCount('stanza')).toBe(2); // Push responder plus response waiter.
      await vi.advanceTimersByTimeAsync(20000);
      await ready;
      expect(h.emitter.listenerCount('stanza')).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('late roster write failure'));
      h.emitter.emit(
        'stanza',
        xml('iq', { type: 'result', id }, xml('query', { xmlns: 'jabber:iq:roster' }))
      );
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.broadcasts()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
  it('late subscribed completion cannot send presence or undo a subsequent unsubscribe', async () => {
    const h = fixture({ presenceAllowFrom: [alice] });
    await h.controller.ready(true);
    h.send.mockClear();
    const wire = await nativeWire(h);
    const subscribe = h.controller.handle('subscribe', alice);
    await vi.advanceTimersByTimeAsync(20000);
    await subscribe;
    expect(wire).toHaveLength(1);
    expect(wire[0].data).toContain('type="subscribed"');
    const unsubscribe = h.controller.handle('unsubscribe', alice);
    await vi.advanceTimersByTimeAsync(0);
    expect(wire).toHaveLength(2);
    expect(wire[1].data).toContain('type="unsubscribed"');
    // Reversing callback order cannot reverse bytes already handed to the stream.
    wire[1].complete();
    await unsubscribe;
    wire[0].complete();
    await vi.advanceTimersByTimeAsync(10000);
    expect(wire).toHaveLength(2);
    expect(h.presence().map((s) => s.attrs.type)).toEqual(['subscribed', 'unsubscribed']);
  });
  it('a timed-out unsubscribe is one-shot and cannot contradict a later explicit subscribe', async () => {
    const h = fixture({ presenceAllowFrom: [alice] });
    await h.controller.ready(true);
    h.send.mockClear();
    const wire = await nativeWire(h);
    const unsubscribe = h.controller.handle('unsubscribe', alice);
    await vi.advanceTimersByTimeAsync(20000);
    await unsubscribe;
    const subscribe = h.controller.handle('subscribe', alice);
    await vi.advanceTimersByTimeAsync(0);
    expect(wire).toHaveLength(2);
    expect(wire[0].data).toContain('type="unsubscribed"');
    expect(wire[1].data).toContain('type="subscribed"');
    wire[1].complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire).toHaveLength(3); // One directed presence for the newer explicit approval.
    wire[2].complete();
    await subscribe;
    wire[0].complete();
    await vi.advanceTimersByTimeAsync(10000);
    expect(wire).toHaveLength(3);
  });
  it('a directed presence timeout cannot automatically retry or disclose a newer state after revocation', async () => {
    const h = fixture({ presenceAllowFrom: [alice] });
    await h.controller.ready(true);
    h.send.mockClear();
    const wire = await nativeWire(h);
    const probe = h.controller.handle('probe', alice);
    await vi.advanceTimersByTimeAsync(20000);
    await probe;
    expect(wire).toHaveLength(1);
    h.config.presenceAllowFrom = [];
    wire[0].complete();
    await vi.advanceTimersByTimeAsync(10000);
    await h.controller.handle('probe', alice);
    expect(wire).toHaveLength(1); // Already queued authorized bytes cannot be recalled.
  });
  it('late roster revocation leaves the global gate closed and does not start confirmation IO', async () => {
    const h = fixture();
    h.roster([xml('item', { jid: alice, subscription: 'both' })]);
    const wire = await nativeWire(h);
    const ready = h.controller.ready(true);
    await vi.advanceTimersByTimeAsync(20000);
    await ready;
    expect(wire).toHaveLength(1);
    expect(wire[0].data).toContain('type="unsubscribed"');
    expect(h.broadcasts()).toHaveLength(0);
    wire[0].complete();
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.send.mock.calls.filter(([s]) => s.attrs.type === 'get')).toHaveLength(1);
    expect(h.broadcasts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a fallback roster-push ACK is sent once; timeout/late completion do not retransmit', async () => {
    const h = fixture();
    await h.controller.ready(true);
    h.send.mockClear();
    const wire = await nativeWire(h);
    h.emitter.emit(
      'stanza',
      xml('iq', { type: 'set', id: 'push-late' }, xml('query', { xmlns: 'jabber:iq:roster' }))
    );
    await vi.advanceTimersByTimeAsync(20000);
    expect(wire).toHaveLength(1);
    expect(wire[0].data).toContain('type="result"');
    h.controller.dispose();
    wire[0].complete();
    await vi.advanceTimersByTimeAsync(10000);
    expect(wire).toHaveLength(1);
    expect(h.emitter.listenerCount('stanza')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('persistent roster reconciliation', () => {
  const item = (subscription: string, jid = alice) => xml('item', { jid, subscription });
  it('revokes stale preapprovals without deleting the roster contact', async () => {
    const h = fixture();
    h.roster([xml('item', { jid: alice, subscription: 'none', approved: 'true' })]);
    await h.controller.ready(true);
    expect(h.presence().map((s) => s.attrs.type)).toEqual(['unsubscribed', undefined]);
    expect(h.send.mock.calls.some(([s]) => s.attrs.type === 'set')).toBe(false);
  });
  it('a failed global gate stays closed after SM resumption', async () => {
    const h = fixture();
    h.roster([], 'error');
    await h.controller.ready(true);
    h.disconnect();
    h.reconnect();
    await h.controller.ready(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.broadcasts()).toHaveLength(0);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it.each(['from', 'both'])(
    'preserves trusted %s and publishes after the roster result',
    async (subscription) => {
      const h = fixture({ allowFrom: [alice] });
      h.roster([item(subscription)]);
      await h.controller.ready(true);
      expect(h.send.mock.calls[0][0].getChild('query', 'jabber:iq:roster')).toBeDefined();
      expect(h.presence()).toHaveLength(1);
      expect(h.broadcasts()).toHaveLength(1);
    }
  );
  it.each(['from', 'both'])(
    'revokes removed %s subscriber and confirms before broadcast',
    async (subscription) => {
      const h = fixture();
      h.roster([item(subscription)]);
      await h.controller.ready(true);
      expect(h.send.mock.calls.map(([s]) => s.attrs.type ?? s.name)).toEqual([
        'get',
        'unsubscribed',
        'get',
        'presence',
      ]);
      expect(h.presence()[0].attrs).toEqual({ type: 'unsubscribed', to: alice });
    }
  );
  it('revoked pairing no longer authorizes on a fresh session', async () => {
    const h = fixture();
    pairing.mockResolvedValue([alice]);
    h.roster([item('both')]);
    await h.controller.ready(true);
    pairing.mockResolvedValue([]);
    h.controller.reset();
    await h.controller.ready(true);
    expect(h.presence().map((s) => s.attrs.type)).toEqual([undefined, 'unsubscribed', undefined]);
  });
  it.each(['none', 'to'])(
    'does not revoke %s entries that cannot receive our presence',
    async (subscription) => {
      const h = fixture();
      h.roster([item(subscription)]);
      await h.controller.ready(true);
      expect(h.presence()).toHaveLength(1);
      expect(pairing).not.toHaveBeenCalled();
    }
  );
  it.each(['error', 'missing', 'hang', 'unconfirmed'] as const)(
    'fails closed on roster %s but directed trusted presence works',
    async (mode) => {
      const h = fixture({ presenceAllowFrom: ['bob@example.com'] });
      h.roster([item('from')], mode);
      const ready = h.controller.ready(true);
      await vi.advanceTimersByTimeAsync(5000);
      await ready;
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.broadcasts()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      await h.controller.handle('probe', 'bob@example.com');
      expect(h.presence().at(-1)?.attrs.to).toBe('bob@example.com');
      expect(h.ctx.log?.warn).toHaveBeenCalled();
    }
  );
  it('pairing lookup failure keeps the global gate closed and does not revoke blindly', async () => {
    const h = fixture();
    h.roster([item('both')]);
    pairing.mockRejectedValue(new Error('PRIVATE_STORE_ERROR'));
    await h.controller.ready(true);
    expect(h.presence()).toHaveLength(0);
    expect(h.ctx.log?.warn).toHaveBeenCalledExactlyOnceWith(
      expect.not.stringContaining('PRIVATE_STORE_ERROR')
    );
  });
  it('ignores a spoofed roster response even with the right IQ id', async () => {
    const h = fixture();
    h.roster([], 'hang');
    const pending = h.controller.ready(true);
    h.emitter.emit(
      'stanza',
      xml(
        'iq',
        { type: 'result', id: h.send.mock.calls[0][0].attrs.id, from: 'mallory@example.com' },
        xml('query', { xmlns: 'jabber:iq:roster' })
      )
    );
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(h.broadcasts()).toHaveLength(0);
  });
  it('acknowledges only server-originated roster pushes without caching trust', async () => {
    const h = fixture();
    await h.controller.ready(true);
    h.send.mockClear();
    for (const from of ['mallory@example.com', 'agent@example.com']) {
      h.emitter.emit(
        'stanza',
        xml(
          'iq',
          { type: 'set', id: 'push', from },
          xml('query', { xmlns: 'jabber:iq:roster' }, item('from'))
        )
      );
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].attrs.type).toBe('result');
    await h.controller.handle('probe', alice);
    expect(h.presence()).toHaveLength(0);
  });
});
