import type { Element, XmppClient } from '@xmpp/client';
import { xml } from '@xmpp/client';
import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStartContext } from '../src/types.js';

const mocks = vi.hoisted(() => ({ client: vi.fn(), joinMuc: vi.fn() }));
vi.mock('@xmpp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xmpp/client')>()),
  client: mocks.client,
}));
vi.mock('../src/rooms.js', () => ({ joinMuc: mocks.joinMuc }));

import { startXmppConnection } from '../src/monitor.js';
import { scheduleReconnect } from '../src/reconnect.js';
import {
  activeClients,
  cleanupAccountState,
  keepaliveIntervals,
  pendingMucJoins,
  reconnectStates,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  type ReconnectState,
} from '../src/state.js';

const accountId = 'online-test';
const rooms = ['first@conference.example.com', 'second@conference.example.com'];
let controller: AbortController;
let connection: Promise<void> | undefined;
let releases: Array<() => void>;
let emitters: EventEmitter[];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

async function connect(
  streamManagement?: { enabled: boolean; enableSent: boolean },
  advertised?: boolean
) {
  const events: string[] = [];
  const log = {
    info: vi.fn((message: string) => {
      if (message.includes('XMPP online as')) events.push('online');
    }),
    debug: vi.fn((message: string) => {
      if (message.includes('keepalive started')) events.push('keepalive');
    }),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const setStatus = vi.fn((patch) => {
    if (patch.connected) events.push('connected');
  });
  let online: ((address: { toString(): string }) => void) | undefined;
  let startupOnline: (() => void) | undefined;
  const emitter = new EventEmitter();
  emitters.push(emitter);
  const send = vi.fn((stanza: Element) => {
    events.push(stanza.is('iq') ? 'carbons' : 'presence');
    return Promise.resolve();
  });
  const xmpp = {
    status: 'offline',
    options: { service: 'xmpp://example.com:5222', domain: 'example.com' },
    streamManagement,
    reconnect: { stop: vi.fn() },
    on: vi.fn((event: string, handler: typeof online) => {
      if (handler) emitter.on(event, handler);
      if (event === 'online') {
        if (online) startupOnline = handler;
        else online = handler;
      }
    }),
    off: vi.fn((event: string, handler: () => void) => emitter.off(event, handler)),
    connect: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(async () => startupOnline?.()),
    stop: vi.fn().mockResolvedValue(undefined),
    send,
  };
  mocks.client.mockReturnValue(xmpp);
  mocks.joinMuc.mockImplementation((_client, room) => {
    events.push(room);
    return Promise.resolve();
  });
  controller = new AbortController();
  const ctx: GatewayStartContext = {
    accountId,
    account: {
      accountId,
      enabled: true,
      config: { jid: 'bot@example.com', password: 'password', groups: rooms },
    },
    cfg: {},
    abortSignal: controller.signal,
    log,
    setStatus,
  };
  connection = startXmppConnection(ctx);
  await vi.advanceTimersByTimeAsync(0); // Let startup register connection cleanup.
  if (!online) throw new Error('online listener was not registered');
  if (advertised !== undefined) {
    emitter.emit(
      'element',
      xml(
        'stream:features',
        { 'xmlns:stream': 'http://etherx.jabber.org/streams' },
        ...(advertised ? [xml('sm', { xmlns: 'urn:xmpp:sm:3' })] : [])
      )
    );
  }
  log.info.mockClear();
  log.debug.mockClear();
  setStatus.mockClear();
  return { online, xmpp, send, emitter, log, setStatus, events, ctx };
}

// Replacements use the real plugin scheduler and emit online during startup,
// so tests exercise both transport startup and the detached online task.
function retryClient() {
  const emitter = new EventEmitter();
  emitters.push(emitter);
  const sm = { enabled: false, enableSent: false };
  const send = vi.fn().mockResolvedValue(undefined);
  const xmpp = {
    status: 'offline',
    options: { service: 'xmpp://example.com:5222', domain: 'example.com' },
    streamManagement: sm,
    reconnect: { stop: vi.fn() },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    connect: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(async () => {
      emitter.emit(
        'element',
        xml(
          'features',
          { xmlns: 'http://etherx.jabber.org/streams' },
          xml('sm', { xmlns: 'urn:xmpp:sm:3' })
        )
      );
      emitter.emit('online', { toString: () => 'bot@example.com/resource' });
    }),
    stop: vi.fn(async () => {
      emitter.emit('disconnect');
      emitter.emit('offline');
    }),
    send,
  };
  return { xmpp, sm, send, emitter };
}

function seedRecovery(): ReconnectState {
  const state = { attempts: 3, lastAttemptAt: Date.now(), nextDelayMs: 8000, aborted: false };
  reconnectStates.set(accountId, state);
  return state;
}

function expectRecoveryReset() {
  expect(reconnectStates.get(accountId)).toEqual({
    attempts: 0,
    lastAttemptAt: 0,
    nextDelayMs: RECONNECT_BASE_DELAY_MS,
    aborted: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  releases = [];
  emitters = [];
});

afterEach(async () => {
  try {
    for (const release of releases) release();
    await vi.advanceTimersByTimeAsync(0);
    controller?.abort();
    await connection;
    await vi.advanceTimersByTimeAsync(0); // Drain replacement connection lifetimes too.
    cleanupAccountState(accountId);
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    expect(activeClients.has(accountId)).toBe(false);
    expect(reconnectStates.has(accountId)).toBe(false);
    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const emitter of emitters) {
      expect(emitter.listenerCount('element')).toBe(0);
      expect(emitter.listenerCount('nonza')).toBe(0);
      expect(emitter.listenerCount('disconnect')).toBe(0);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally {
    connection = undefined;
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('online listener lifecycle', () => {
  it('returns void and waits for SM readiness before the sequential online phases', async () => {
    const sm = { enabled: false, enableSent: false };
    const h = await connect(sm, true);
    const carbons = deferred();
    const presence = deferred();
    const firstJoin = deferred();
    h.send
      .mockImplementationOnce(() => {
        h.events.push('carbons');
        return carbons.promise;
      })
      .mockImplementationOnce(() => {
        h.events.push('presence');
        return presence.promise;
      });
    mocks.joinMuc.mockImplementationOnce((_client, room) => {
      h.events.push(room);
      return firstJoin.promise;
    });

    expect(h.online({ toString: () => 'bot@example.com/resource' })).toBeUndefined();
    expect(h.events).toEqual(['online']);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.send).not.toHaveBeenCalled();
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    sm.enableSent = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(mocks.joinMuc).not.toHaveBeenCalled();

    sm.enabled = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).toEqual(['online', 'keepalive', 'carbons']);
    expect(keepaliveIntervals.has(accountId)).toBe(true);
    expect(h.send.mock.calls[0][0].getChild('enable', 'urn:xmpp:carbons:2')).toBeDefined();
    carbons.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(['online', 'keepalive', 'carbons', 'presence']);
    presence.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(['online', 'keepalive', 'carbons', 'presence', 'connected', rooms[0]]);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
    firstJoin.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(['online', 'keepalive', 'carbons', 'presence', 'connected', ...rooms]);
    expect(mocks.joinMuc).toHaveBeenNthCalledWith(
      2,
      h.xmpp,
      rooms[1],
      'bot',
      h.log,
      accountId,
      true
    );
    expect(h.setStatus).toHaveBeenCalledWith({
      accountId,
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      lastError: null,
    });
  });

  it('ignores a stale client before logging or starting keepalive', async () => {
    const h = await connect();
    const replacement = { stop: vi.fn().mockResolvedValue(undefined) } as unknown as XmppClient;
    activeClients.set(accountId, replacement);
    expect(h.online({ toString: () => 'bot@example.com/resource' })).toBeUndefined();
    expect(h.events).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    expect(activeClients.get(accountId)).toBe(replacement);
  });

  it.each(['unavailable', 'unsupported', 'enabled'])(
    'initializes without a timer delay when SM is %s',
    async (mode) => {
      const sm =
        mode === 'unavailable' ? undefined : { enabled: mode === 'enabled', enableSent: false };
      const h = await connect(sm, mode === 'enabled');
      h.online({ toString: () => 'bot@example.com/resource' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.events).toEqual([
        'online',
        'keepalive',
        'carbons',
        'presence',
        'connected',
        ...rooms,
      ]);
      expect(h.emitter.listenerCount('nonza')).toBe(0);
      expect(vi.getTimerCount()).toBe(1); // Only keepalive remains.
    }
  );

  it('waits for library state, not just receipt of the enabled nonza', async () => {
    const sm = { enabled: false, enableSent: true };
    const h = await connect(sm, true);
    h.online({ toString: () => 'bot@example.com/resource' });
    h.emitter.emit('nonza', xml('enabled', { xmlns: 'urn:xmpp:sm:3' }));
    await vi.advanceTimersByTimeAsync(20);
    expect(h.send).not.toHaveBeenCalled();
    sm.enabled = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.emitter.listenerCount('nonza')).toBe(0);
  });

  it('continues without SM only after the library processes an enable failure', async () => {
    const sm = { enabled: false, enableSent: true };
    const h = await connect(sm, true);
    h.online({ toString: () => 'bot@example.com/resource' });
    h.emitter.emit('nonza', xml('failed', { xmlns: 'urn:xmpp:sm:3' }));
    await vi.advanceTimersByTimeAsync(20);
    expect(h.send).not.toHaveBeenCalled();
    sm.enableSent = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).toEqual(['online', 'keepalive', 'carbons', 'presence', 'connected', ...rooms]);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('does not mistake a pre-online resumption failure for a settled enable', async () => {
    const sm = { enabled: false, enableSent: false };
    const h = await connect(sm, true);
    h.emitter.emit('nonza', xml('failed', { xmlns: 'urn:xmpp:sm:3' }));
    h.online({ toString: () => 'bot@example.com/resource' });
    await vi.advanceTimersByTimeAsync(20);
    expect(h.send).not.toHaveBeenCalled();
    sm.enabled = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it.each(['abort', 'replace', 'remove', 'disconnect', 'offline'])(
    'cancels pending initialization on %s and releases its wait resources',
    async (mode) => {
      const sm = { enabled: false, enableSent: false };
      const h = await connect(sm, true);
      h.online({ toString: () => 'bot@example.com/resource' });
      const queued = h.xmpp.send(xml('message', { to: 'user@example.com' }));
      const rejection = expect(queued).rejects.toThrow('cancelled');
      if (mode === 'abort') controller.abort();
      else if (mode === 'replace') {
        activeClients.set(accountId, {
          stop: vi.fn().mockResolvedValue(undefined),
        } as unknown as XmppClient);
      } else if (mode === 'remove') activeClients.delete(accountId);
      else h.emitter.emit(mode);
      sm.enabled = true;
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(h.send).not.toHaveBeenCalled();
      expect(mocks.joinMuc).not.toHaveBeenCalled();
      expect(h.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
      expect(keepaliveIntervals.has(accountId)).toBe(false);
      expect(h.emitter.listenerCount('nonza')).toBe(0);
      expect(vi.getTimerCount()).toBe(mode === 'offline' ? 1 : 0);
    }
  );

  it('ignores online after abort', async () => {
    const h = await connect({ enabled: false, enableSent: false }, true);
    controller.abort();
    await connection;
    h.online({ toString: () => 'bot@example.com/resource' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('replaces a pending online task and initializes only the latest generation', async () => {
    const sm = { enabled: false, enableSent: false };
    const h = await connect(sm, true);
    h.online({ toString: () => 'bot@example.com/resource' });
    h.online({ toString: () => 'bot@example.com/resource' });
    expect(h.emitter.listenerCount('nonza')).toBe(1);
    expect(vi.getTimerCount()).toBe(2);
    sm.enabled = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
    expect(h.setStatus).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    're-evaluates SM support on a new stream: advertised=%s',
    async (advertised) => {
      const sm = { enabled: false, enableSent: false };
      const h = await connect(sm, false);
      h.online({ toString: () => 'bot@example.com/resource' });
      await vi.advanceTimersByTimeAsync(0);
      h.emitter.emit('disconnect');
      h.send.mockClear();
      h.setStatus.mockClear();
      mocks.joinMuc.mockClear();
      h.emitter.emit(
        'element',
        xml(
          'features',
          { xmlns: 'http://etherx.jabber.org/streams' },
          ...(advertised ? [xml('sm', { xmlns: 'urn:xmpp:sm:3' })] : [])
        )
      );
      h.online({ toString: () => 'bot@example.com/resource' });
      await vi.advanceTimersByTimeAsync(20);
      if (advertised) {
        expect(h.send).not.toHaveBeenCalled();
        expect(keepaliveIntervals.has(accountId)).toBe(false);
        sm.enabled = true;
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
      expect(h.setStatus).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    }
  );

  it.each(['advertised', 'unknown', 'stop failure'])(
    'fails closed and schedules recovery when negotiation stays pending: %s',
    async (mode) => {
      const h = await connect(
        { enabled: false, enableSent: false },
        mode === 'unknown' ? undefined : true
      );
      if (mode === 'stop failure') h.xmpp.stop.mockRejectedValueOnce(new Error('stop failed'));
      h.online({ toString: () => 'bot@example.com/resource' });
      // A failure in an unrelated protocol cannot settle SM.
      h.emitter.emit('nonza', xml('failed', { xmlns: 'urn:example:unrelated' }));
      await vi.advanceTimersByTimeAsync(9999);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.xmpp.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.xmpp.stop).not.toHaveBeenCalled();
      expect(h.xmpp.reconnect.stop).toHaveBeenCalledTimes(1);
      expect(h.setStatus).toHaveBeenCalledWith({
        accountId,
        lastError: 'XEP-0198 negotiation did not settle within 10000ms',
      });
      expect(h.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
      expect(mocks.joinMuc).not.toHaveBeenCalled();
      expect(h.emitter.listenerCount('nonza')).toBe(0);
      expect(keepaliveIntervals.has(accountId)).toBe(false);
      expect(reconnectStates.get(accountId)?.attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(1); // Only plugin backoff remains.
      const next = retryClient();
      mocks.client.mockReturnValue(next.xmpp);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      expect(h.xmpp.stop).toHaveBeenCalledTimes(1);
      expect(activeClients.get(accountId)).toBe(next.xmpp);
      if (mode === 'stop failure') {
        expect(h.log.warn).toHaveBeenCalledWith(
          `[${accountId}] Stale client stop failed: stop failed`
        );
      }
    }
  );

  it('restores keepalive on SM resumption without repeating application initialization', async () => {
    const sm = Object.assign(new EventEmitter(), { enabled: true, enableSent: true });
    const h = await connect(sm, true);
    h.online({ toString: () => 'bot@example.com/resource' });
    await vi.advanceTimersByTimeAsync(0);
    sm.enabled = false;
    sm.enableSent = false;
    h.emitter.emit('disconnect');
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    seedRecovery();
    scheduleReconnect(accountId, h.ctx);
    expect(reconnectStates.get(accountId)?.timer).toBeDefined();
    sm.enabled = true;
    sm.emit('resumed'); // xmpp.js does not emit online for a resumed stream.
    await vi.advanceTimersByTimeAsync(0);
    expect(keepaliveIntervals.has(accountId)).toBe(true);
    expectRecoveryReset();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
    expect(h.setStatus).toHaveBeenCalledWith({
      accountId,
      connected: true,
      lastConnectedAt: expect.any(Number),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.send.mock.calls[2][0].getChild('ping', 'urn:xmpp:ping')).toBeDefined();
    controller.abort();
    await connection;
    h.setStatus.mockClear();
    sm.emit('resumed');
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(keepaliveIntervals.has(accountId)).toBe(false);
  });

  it('holds other application traffic while allowing SM protocol nonzas', async () => {
    const sm = { enabled: false, enableSent: false };
    const h = await connect(sm, true);
    h.online({ toString: () => 'bot@example.com/resource' });
    const message = xml('message', { to: 'user@example.com' }, xml('body', {}, 'Hello'));
    const outbound = h.xmpp.send(message);
    const enable = xml('enable', { xmlns: 'urn:xmpp:sm:3' });
    await h.xmpp.send(enable);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(enable);
    sm.enableSent = true;
    sm.enabled = true;
    await vi.advanceTimersByTimeAsync(10);
    await outbound;
    expect(h.send).toHaveBeenCalledWith(message);
    expect(h.send).toHaveBeenCalledTimes(4);
  });

  it.each(['carbons', 'presence', 'join'])(
    'does not continue the old online phases after abort during %s',
    async (phase) => {
      const h = await connect();
      const pending = deferred();
      if (phase === 'carbons') h.send.mockReturnValueOnce(pending.promise);
      if (phase === 'presence')
        h.send.mockResolvedValueOnce(undefined).mockReturnValueOnce(pending.promise);
      if (phase === 'join') mocks.joinMuc.mockReturnValueOnce(pending.promise);
      h.online({ toString: () => 'bot@example.com/resource' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.send).toHaveBeenCalledTimes(phase === 'carbons' ? 1 : 2);
      expect(mocks.joinMuc).toHaveBeenCalledTimes(phase === 'join' ? 1 : 0);
    }
  );

  it.each(['carbons', 'presence'])(
    'continues through status and joins after %s failure',
    async (phase) => {
      seedRecovery();
      const h = await connect();
      if (phase === 'presence') h.send.mockResolvedValueOnce(undefined);
      h.send.mockRejectedValueOnce(new Error(`${phase} failed`));
      expect(h.online({ toString: () => 'bot@example.com/resource' })).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.setStatus).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
      expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
      expectRecoveryReset();
      if (phase === 'carbons') {
        expect(h.log.warn).toHaveBeenCalledWith(
          `[${accountId}] Failed to enable carbons: carbons failed`
        );
        expect(h.log.error).not.toHaveBeenCalled();
      } else {
        expect(h.log.error).toHaveBeenCalledTimes(1);
        expect(h.log.error).toHaveBeenCalledWith(
          `[${accountId}] XMPP failed to send initial presence: presence failed`
        );
      }
    }
  );

  it('contains join failure locally and leaves rooms available for a later online event', async () => {
    seedRecovery();
    const h = await connect();
    mocks.joinMuc.mockRejectedValueOnce(new Error('join failed'));
    h.online({ toString: () => 'bot@example.com/resource' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.log.warn).toHaveBeenCalledWith(
      `[${accountId}] Room (re)join interrupted (non-fatal, will retry on reconnect): join failed`
    );
    expect(h.log.error).not.toHaveBeenCalled();
    expect(mocks.joinMuc).toHaveBeenCalledTimes(1);
    expect(activeClients.get(accountId)).toBe(h.xmpp);
    expect(reconnectStates.get(accountId)?.timer).toBeUndefined();
    expectRecoveryReset();
    h.online({ toString: () => 'bot@example.com/resource' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['none', 'log', 'status', 'both'])(
    'owns unexpected failure with terminal reporting failure: %s',
    async (reportFailure) => {
      const h = await connect();
      h.log.info.mockImplementationOnce(() => {
        throw new Error('online failed');
      });
      if (reportFailure === 'log' || reportFailure === 'both') {
        h.log.error.mockImplementationOnce(() => {
          throw new Error('error logger failed');
        });
      }
      if (reportFailure === 'status' || reportFailure === 'both') {
        h.setStatus.mockImplementationOnce(() => {
          throw new Error('status failed');
        });
      }
      expect(h.online({ toString: () => 'bot@example.com/resource' })).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.log.error).toHaveBeenCalledTimes(1);
      expect(h.log.error).toHaveBeenCalledWith(
        `[${accountId}] XMPP online task failed: online failed`
      );
      expect(h.setStatus).toHaveBeenCalledTimes(1);
      expect(h.setStatus).toHaveBeenCalledWith({ accountId, lastError: 'online failed' });
      expect(activeClients.get(accountId)).toBe(h.xmpp);
      expect(reconnectStates.get(accountId)?.timer).toBeUndefined();
      expect(h.send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});

describe('SM readiness recovery', () => {
  it('preserves backoff across successive SM timeouts and resets only after current SM readiness', async () => {
    const h = await connect({ enabled: false, enableSent: false }, true);
    const recovery = reconnectStates.get(accountId)!;
    expectRecoveryReset();
    h.online({ toString: () => 'bot@example.com/resource' });
    let current: typeof h.xmpp | ReturnType<typeof retryClient>['xmpp'] = h.xmpp;

    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(reconnectStates.get(accountId)).toBe(recovery);
      expect(recovery.attempts).toBe(attempt - 1);
      await vi.advanceTimersByTimeAsync(10_000);
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
      expect(reconnectStates.get(accountId)).toBe(recovery);
      expect(recovery.attempts).toBe(attempt);
      expect(recovery.nextDelayMs).toBe(delay * 2);
      expect(h.setStatus).toHaveBeenCalledWith({
        accountId,
        reconnectAttempts: attempt,
        reconnectNextAt: Date.now() + delay,
      });
      expect(current.reconnect.stop).toHaveBeenCalledTimes(1);
      expect(current.stop).not.toHaveBeenCalled();

      const next = retryClient();
      mocks.client.mockReturnValue(next.xmpp);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mocks.client).toHaveBeenCalledTimes(attempt);
      await vi.advanceTimersByTimeAsync(1);
      expect(current.stop).toHaveBeenCalledTimes(1);
      expect(mocks.client).toHaveBeenCalledTimes(attempt + 1);
      expect(activeClients.get(accountId)).toBe(next.xmpp);
      expect(reconnectStates.get(accountId)).toBe(recovery);
      expect(recovery.attempts).toBe(attempt);
      expect(next.send).not.toHaveBeenCalled();
      current = next.xmpp;
    }

    current.streamManagement!.enabled = true;
    await vi.advanceTimersByTimeAsync(10);
    expectRecoveryReset();
    expect(h.log.error).toHaveBeenCalledTimes(3);
    expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1); // Only the successful connection's keepalive.
  });

  it.each(['resolved', 'wedged'])(
    'enforces the reconnect limit and discards the final SM client with a %s stop',
    async (stopMode) => {
      const recovery = seedRecovery();
      recovery.attempts = RECONNECT_MAX_ATTEMPTS - 1;
      recovery.nextDelayMs = RECONNECT_MAX_DELAY_MS;
      const h = await connect({ enabled: false, enableSent: false }, true);
      h.online({ toString: () => 'bot@example.com/resource' });
      expect(reconnectStates.get(accountId)).toBe(recovery);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(recovery.attempts).toBe(RECONNECT_MAX_ATTEMPTS);
      expect(recovery.nextDelayMs).toBe(RECONNECT_MAX_DELAY_MS);

      const next = retryClient();
      if (stopMode === 'wedged') {
        next.xmpp.stop.mockImplementation(() => {
          next.emitter.emit('disconnect');
          next.emitter.emit('offline');
          return new Promise<void>(() => {});
        });
      }
      mocks.client.mockReturnValue(next.xmpp);
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
      expect(reconnectStates.get(accountId)).toBe(recovery);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(recovery.attempts).toBe(RECONNECT_MAX_ATTEMPTS);
      expect(recovery.timer).toBeUndefined();
      expect(recovery.aborted).toBe(true);
      expect(activeClients.has(accountId)).toBe(false);
      expect(next.xmpp.stop).toHaveBeenCalledTimes(1);
      expect(h.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
          running: false,
          connected: false,
        })
      );
      expect(h.log.error).toHaveBeenCalledWith(
        `[${accountId}] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached, giving up`
      );
      expect(next.xmpp.reconnect.stop).toHaveBeenCalledTimes(2);
      if (stopMode === 'wedged') {
        expect(vi.getTimerCount()).toBe(1); // Teardown deadline, never a reconnect timer.
        await vi.advanceTimersByTimeAsync(4999);
        expect(vi.getTimerCount()).toBe(1);
        expect(mocks.client).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.log.warn).toHaveBeenCalledWith(
          `[${accountId}] Stale client stop exceeded 5000ms; abandoning it`
        );
      }
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 2);
      expect(mocks.client).toHaveBeenCalledTimes(2);
      expect(next.send).not.toHaveBeenCalled();
      expect(next.xmpp.stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['SM enabled', 'unsupported', 'unavailable'])(
    'resets recovery only after a current successful gate: %s',
    async (mode) => {
      const recovery = seedRecovery();
      const sm = mode === 'unavailable' ? undefined : { enabled: false, enableSent: false };
      const h = await connect(sm, mode === 'SM enabled');
      expect(reconnectStates.get(accountId)).toBe(recovery);
      h.online({ toString: () => 'bot@example.com/resource' });
      if (mode === 'SM enabled') {
        await vi.advanceTimersByTimeAsync(20);
        expect(reconnectStates.get(accountId)).toBe(recovery);
        sm!.enabled = true;
      }
      await vi.advanceTimersByTimeAsync(10);
      expectRecoveryReset();
      expect(h.send).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['aborted', 'replaced', 'superseded'])(
    'does not reset recovery from an %s online generation',
    async (mode) => {
      const recovery = seedRecovery();
      const sm = Object.assign(new EventEmitter(), { enabled: false, enableSent: false });
      const h = await connect(sm, true);
      h.online({ toString: () => 'bot@example.com/resource' });
      if (mode === 'aborted') controller.abort();
      else if (mode === 'replaced') {
        activeClients.set(accountId, {
          stop: vi.fn().mockResolvedValue(undefined),
        } as unknown as XmppClient);
      } else h.online({ toString: () => 'bot@example.com/resource' });
      if (mode !== 'superseded') {
        sm.enabled = true;
        sm.emit('resumed');
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(reconnectStates.get(accountId)).toBe(mode === 'aborted' ? undefined : recovery);
      expect(h.send).not.toHaveBeenCalled();
      expect(mocks.joinMuc).not.toHaveBeenCalled();
    }
  );

  it('reports SM timeout immediately and lets scheduled teardown bound a wedged stop', async () => {
    const h = await connect({ enabled: false, enableSent: false }, true);
    const recovery = reconnectStates.get(accountId)!;
    h.xmpp.stop.mockReturnValue(new Promise<void>(() => {}));
    const next = retryClient();
    mocks.client.mockReturnValue(next.xmpp);
    h.online({ toString: () => 'bot@example.com/resource' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.log.error).toHaveBeenCalledExactlyOnceWith(
      `[${accountId}] XMPP online task failed: XEP-0198 negotiation did not settle within 10000ms`
    );
    expect(h.setStatus).toHaveBeenCalledWith({
      accountId,
      lastError: 'XEP-0198 negotiation did not settle within 10000ms',
    });
    expect(h.xmpp.reconnect.stop).toHaveBeenCalledTimes(1);
    expect(h.xmpp.stop).not.toHaveBeenCalled();
    expect(recovery.attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 4999);
    expect(h.xmpp.stop).toHaveBeenCalledTimes(1);
    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(activeClients.has(accountId)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      `[${accountId}] Stale client stop exceeded 5000ms; abandoning it`
    );
    expect(mocks.client).toHaveBeenCalledTimes(2);
    expect(activeClients.get(accountId)).toBe(next.xmpp);
    expect(reconnectStates.get(accountId)).toBe(recovery);
    expect(recovery.attempts).toBe(1);
    expect(h.xmpp.stop).toHaveBeenCalledTimes(1);
    next.sm.enabled = true;
    await vi.advanceTimersByTimeAsync(10);
    expectRecoveryReset();
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});
