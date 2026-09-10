import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xml, type Element } from '@xmpp/client';
import type { GatewayStartContext } from '../src/types.js';

const construction = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock('../src/xmpp.js', async (original) => ({
  ...(await original<typeof import('../src/xmpp.js')>()),
  client: construction.client,
}));

import { startXmppConnection } from '../src/monitor.js';
import {
  accountLifecycles,
  activeClients,
  clientDisposers,
  cleanupAccountState,
  keepaliveIntervals,
  reconnectStates,
} from '../src/state.js';
import { scheduleReconnect } from '../src/reconnect.js';
import { TRANSPORT_CLOSE_BUDGET_MS } from '../src/transport.js';

const require = createRequire(import.meta.url);
const { default: ConnectionTCP } = await import(require.resolve('@xmpp/connection-tcp'));
const { Parser } = await import(require.resolve('@xmpp/xml'));
const native = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
const accountId = 'graceful-test';
const SM = 'urn:xmpp:sm:3';
const STREAM = 'http://etherx.jabber.org/streams';

type Session = { resource: string; id?: string; handled: number; resumable: boolean };

/** Only the network and peer are fixtures. Client connect/open/send/stop,
 * disconnect, framing, both XML parsers, binding, middleware and SM are native. */
class Peer {
  sessions = new Map<string, Session>();
  sockets: WireSocket[] = [];
  events: string[] = [];
  sm = true;
  holdPeerClose = false;
  holdSocketClose = false;
  holdWrite?: 'unavailable' | 'footer' | 'message';
  failUnavailable = false;
  refuseConnections = false;
  nextId = 0;

  constructor() {
    const peer = this;
    class Socket extends WireSocket {
      constructor() {
        super(peer);
      }
    }
    class Transport extends ConnectionTCP {}
    Transport.prototype.Socket = Socket;
    construction.client.mockImplementation((options) => {
      const xmpp = native.client(options);
      (xmpp as any).transports.unshift(Transport);
      entities.push(xmpp as any);
      return xmpp;
    });
  }
}

class WireSocket extends EventEmitter {
  destroyed = false;
  parser = new Parser();
  writes: string[] = [];
  held: Array<() => void> = [];
  session?: Session;
  peerClosed = false;
  timers = new Set<ReturnType<typeof setTimeout>>();
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.peer.events.push('destroy');
    this.destroyed = true;
    this.cancelReplies();
    this.markLoss();
    this.emit('close', true);
    this.parser.removeAllListeners();
  });
  end = vi.fn(() => {
    this.peer.events.push('socket:end');
    if (!this.peer.holdSocketClose)
      this.later(() => {
        this.destroyed = true;
        this.markLoss();
        this.emit('close', false);
        this.parser.removeAllListeners();
      });
    return this;
  });

  constructor(readonly peer: Peer) {
    super();
    peer.sockets.push(this);
    this.parser.on('start', () => {
      this.reply(`<stream:stream xmlns="jabber:client" xmlns:stream="${STREAM}">`);
      this.reply(
        xml(
          'stream:features',
          {},
          xml('bind', { xmlns: 'urn:ietf:params:xml:ns:xmpp-bind' }),
          ...(peer.sm ? [xml('sm', { xmlns: SM })] : [])
        ).toString()
      );
    });
    this.parser.on('element', (stanza: Element) => this.stanza(stanza));
    this.parser.on('end', () => {
      peer.events.push('peer:footer');
      this.peerClosed = true;
      if (this.session) peer.sessions.delete(this.session.resource);
      if (!peer.holdPeerClose) this.releasePeerClose();
    });
  }

  private later(run: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) run();
    }, 0);
    this.timers.add(timer);
  }
  private cancelReplies() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  private markLoss() {
    if (!this.peerClosed && this.session) this.session.resumable = true;
  }
  reply(data: string) {
    this.later(() => this.emit('data', Buffer.from(data)));
  }
  releasePeerClose() {
    this.reply('</stream:stream>');
  }
  connect() {
    this.peer.events.push('connect');
    this.later(() => {
      if (this.peer.refuseConnections) {
        this.emit('error', new Error('ECONNREFUSED'));
        this.destroy();
      } else this.emit('connect');
    });
  }
  write(data: string, callback: (error?: Error) => void) {
    if (this.destroyed) throw new Error('Write to destroyed fixture socket');
    this.writes.push(data);
    const kind =
      data === '</stream:stream>'
        ? 'footer'
        : data.startsWith('<presence') && data.includes('type="unavailable"')
          ? 'unavailable'
          : data.startsWith('<message')
            ? 'message'
            : undefined;
    if (kind) this.peer.events.push(`write:${kind}`);
    if (data.startsWith('<a ')) this.peer.events.push('write:sm-ack');
    this.parser.write(data);
    if (kind && this.peer.holdWrite === kind) this.held.push(() => callback());
    else
      callback(
        kind === 'unavailable' && this.peer.failUnavailable ? new Error('write failed') : undefined
      );
    return true;
  }
  private stanza(stanza: Element) {
    if (this.session?.id && ['presence', 'message', 'iq'].includes(stanza.name)) {
      this.session.handled++;
    }
    const bind = stanza.getChild('bind', 'urn:ietf:params:xml:ns:xmpp-bind');
    if (bind) {
      const resource = bind.getChildText('resource') ?? `resource-${this.peer.nextId++}`;
      this.session = { resource, handled: 0, resumable: false };
      this.peer.sessions.set(resource, this.session);
      this.reply(
        xml(
          'iq',
          { type: 'result', id: stanza.attrs.id },
          xml(
            'bind',
            { xmlns: 'urn:ietf:params:xml:ns:xmpp-bind' },
            xml('jid', {}, `agent@example.com/${resource}`)
          )
        ).toString()
      );
    } else if (stanza.name === 'enable' && stanza.attrs.xmlns === SM) {
      this.session!.id = `session-${++this.peer.nextId}`;
      this.reply(xml('enabled', { xmlns: SM, id: this.session!.id, resume: 'true' }).toString());
    } else if (stanza.name === 'resume') {
      this.session = [...this.peer.sessions.values()].find((s) => s.id === stanza.attrs.previd);
      if (!this.session) this.reply(xml('failed', { xmlns: SM }).toString());
      else {
        this.session.resumable = false;
        this.reply(
          xml('resumed', { xmlns: SM, previd: this.session.id, h: this.session.handled }).toString()
        );
      }
    } else if (stanza.getChild('query', 'jabber:iq:roster')) {
      this.reply(
        xml(
          'iq',
          { type: 'result', id: stanza.attrs.id },
          xml('query', { xmlns: 'jabber:iq:roster' })
        ).toString()
      );
    } else if (stanza.name === 'r') {
      this.reply(xml('a', { xmlns: SM, h: this.session?.handled ?? 0 }).toString());
    }
  }
}

let entities: any[];
let peers: Peer[];
let lifetimes: Promise<void>[];

async function start(peer: Peer, advanceMs = 20) {
  const controller = new AbortController();
  const status: Record<string, unknown> = {};
  const ctx: GatewayStartContext = {
    accountId,
    account: {
      accountId,
      enabled: true,
      config: { jid: 'agent@example.com', password: 'fixture', groups: [] },
    },
    cfg: {},
    abortSignal: controller.signal,
    setStatus: vi.fn((patch) => Object.assign(status, patch)),
    getStatus: () => ({ accountId, ...status }),
  };
  const before = entities.length;
  const lifetime = startXmppConnection(ctx);
  lifetimes.push(lifetime);
  await vi.advanceTimersByTimeAsync(advanceMs);
  const entity = entities[before];
  return {
    peer,
    ctx,
    status,
    controller,
    lifetime,
    get entity() {
      return entity ?? entities[before];
    },
  };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
function peer() {
  const p = new Peer();
  peers.push(p);
  return p;
}
function stoppedResources(entity: any) {
  expect(entity.socket).toBeNull();
  expect(entity.parser).toBeNull();
  expect(clientDisposers.has(entity)).toBe(false);
  expect(entity.listenerCount('stanza')).toBe(0);
  expect(entity.streamManagement.listenerCount('resumed')).toBe(0);
  expect(entity.iqCaller.handlers.size).toBe(0);
  expect(activeClients.size).toBe(0);
  expect(reconnectStates.size).toBe(0);
  expect(keepaliveIntervals.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.25);
  construction.client.mockReset();
  entities = [];
  peers = [];
  lifetimes = [];
});
afterEach(async () => {
  const stopped = accountLifecycles.get(accountId)?.stop();
  await vi.advanceTimersByTimeAsync(TRANSPORT_CLOSE_BUDGET_MS);
  await stopped;
  await Promise.all(lifetimes);
  cleanupAccountState(accountId);
  for (const p of peers) for (const socket of p.sockets) socket.destroy();
  for (const entity of entities) entity.reconnect.stop();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('deliberate logical XMPP teardown', () => {
  it.each([true, false])(
    'T1/T2 sends the real stream footer to the peer before retirement (SM=%s)',
    async (sm) => {
      const p = peer();
      p.sm = sm;
      const h = await start(p);
      expect(h.status.connected).toBe(true);
      const socket = p.sockets[0];
      h.entity.on('close', () => p.events.push('client:peer-end'));
      h.entity.on('offline', () => p.events.push('client:offline'));
      h.entity.on('disconnect', () => {
        // retire() cancels native SM timers after stop() has emitted offline.
        if (h.entity.status === 'offline') p.events.push('retired:disconnect');
      });
      p.events.length = 0;
      const done = accountLifecycles.get(accountId)!.stop();
      await vi.advanceTimersByTimeAsync(10);
      await done;
      expect(socket.writes).toContain('</stream:stream>');
      expect(p.events).toEqual([
        'write:unavailable',
        ...(sm ? ['write:sm-ack'] : []),
        'write:footer',
        'peer:footer',
        'client:peer-end',
        'socket:end',
        'client:offline',
        'retired:disconnect',
      ]);
      expect(p.sessions.size).toBe(0);
      expect(h.entity.streamManagement.id).toBe('');
      stoppedResources(h.entity);
    }
  );

  it('T1 closes an online SM stream before monitor readiness without terminal unavailable', async () => {
    const p = peer();
    p.holdPeerClose = true;
    // Native 0.14.0 binding emits online before SM enable completes. Advance
    // through the real enabled response, but not the monitor's 10ms readiness poll.
    const h = await start(p, 5);
    const socket = p.sockets[0];
    expect(h.entity.status).toBe('online');
    expect(h.entity.streamManagement.enabled).toBe(true);
    expect(h.entity.streamManagement.id).not.toBe('');
    expect(h.status.connected).not.toBe(true);
    expect(keepaliveIntervals.size).toBe(0);
    expect(socket.writes.some((frame) => frame.startsWith('<presence'))).toBe(false);
    expect(activeClients.get(accountId)).toBe(h.entity);
    expect(h.entity.socket).toBe(socket);
    expect(h.entity.parser).not.toBeNull();
    expect(p.sessions.size).toBe(1);

    const closeStream = vi.spyOn(h.entity, '_closeStream');
    const hook = vi.fn(() => p.events.push('close:hook'));
    h.entity.hook('close', hook);
    h.entity.on('close', () => p.events.push('client:peer-end'));
    h.entity.on('offline', () => p.events.push('client:offline'));
    h.entity.on('disconnect', () => {
      if (h.entity.status === 'offline') p.events.push('retired:disconnect');
    });
    p.events.length = 0;
    const owner = accountLifecycles.get(accountId)!;
    const began = Date.now();
    const done = owner.stop();
    expect(owner.stop()).toBe(done);
    const completed = vi.fn();
    void done.then(completed);
    await vi.advanceTimersByTimeAsync(10);

    expect(socket.writes.filter((frame) => frame.includes('type="unavailable"'))).toHaveLength(0);
    expect(closeStream).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledOnce();
    expect(socket.writes.filter((frame) => frame === '</stream:stream>')).toHaveLength(1);
    expect(p.events).toEqual(['write:sm-ack', 'close:hook', 'write:footer', 'peer:footer']);
    expect(p.sessions.size).toBe(0);
    expect(socket.destroyed).toBe(false);
    expect(socket.end).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(owner.stop()).toBe(done);

    socket.releasePeerClose();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(Date.now() - began).toBeLessThanOrEqual(TRANSPORT_CLOSE_BUDGET_MS);
    expect(owner.stop()).toBe(done);
    expect(completed).toHaveBeenCalledOnce();
    expect(p.events).toEqual([
      'write:sm-ack',
      'close:hook',
      'write:footer',
      'peer:footer',
      'client:peer-end',
      'socket:end',
      'client:offline',
      'retired:disconnect',
    ]);
    expect(socket.destroyed).toBe(true);
    expect(p.sessions.size).toBe(0);
    expect(h.entity.streamManagement.id).toBe('');
    stoppedResources(h.entity);
  });

  it.each(['abort', 'disable', 'cleanup'])(
    'T1 deliberate %s reaches the native logical close path',
    async (mode) => {
      const p = peer();
      const h = await start(p);
      if (mode === 'abort') h.controller.abort();
      else {
        if (mode === 'disable') h.ctx.account.enabled = false;
        cleanupAccountState(accountId);
      }
      await vi.advanceTimersByTimeAsync(10);
      await h.lifetime;
      expect(p.sockets[0].writes).toContain('</stream:stream>');
      expect(p.sockets[0].writes.filter((s) => s.includes('type="unavailable"'))).toHaveLength(1);
      expect(p.sessions.size).toBe(0);
      stoppedResources(h.entity);
    }
  );

  it('T3 preserves same-client native SM resume, queue replay and exponential backoff after accidental loss', async () => {
    const p = peer();
    const h = await start(p);
    const entity = h.entity;
    const sm = entity.streamManagement;
    const id = sm.id;
    sm.inbound = 41;
    await entity.send(xml('message', { to: 'user@example.com' }, xml('body', {}, 'queued')));
    const queued = [...sm.outbound_q];
    // The peer did not acknowledge the visible message: exercise real replay.
    p.sockets[0].session!.handled--;
    const stop = vi.spyOn(entity, 'stop');
    p.refuseConnections = true;
    p.sockets[0].destroy();
    expect(p.sessions.values().next().value?.resumable).toBe(true);
    expect(sm.id).toBe(id);
    expect(sm.inbound).toBe(41);
    expect(sm.outbound_q).toEqual(queued);
    expect(reconnectStates.get(accountId)?.nextDelayMs).toBe(2000);
    await vi.advanceTimersByTimeAsync(1010);
    expect(reconnectStates.get(accountId)?.nextDelayMs).toBe(4000);
    await vi.advanceTimersByTimeAsync(2010);
    expect(reconnectStates.get(accountId)?.nextDelayMs).toBe(8000);
    p.refuseConnections = false;
    await vi.advanceTimersByTimeAsync(4020);
    expect(activeClients.get(accountId)).toBe(entity);
    expect(construction.client).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(sm.id).toBe(id);
    expect(sm.inbound).toBeGreaterThanOrEqual(41);
    expect(entity.status).toBe('online');
    const wire = p.sockets.at(-1)!.writes.join('');
    expect(wire).toContain(`<resume xmlns="${SM}" h="41" previd="${id}"/>`);
    expect(wire).toContain('queued');
    expect(p.sockets.flatMap((s) => s.writes).some((s) => s.includes('type="unavailable"'))).toBe(
      false
    );
    expect(reconnectStates.get(accountId)?.attempts).toBe(0);
  });

  it.each(['peer', 'footer', 'hook', 'socket', 'stop wedge', 'stop failure'])(
    'T4 bounds terminal %s failure and releases owned resources',
    async (mode) => {
      const p = peer();
      const h = await start(p);
      h.entity.timeout = 30_000; // The plugin's total budget must win over native waits.
      if (mode === 'peer') p.holdPeerClose = true;
      if (mode === 'footer') p.holdWrite = 'footer';
      if (mode === 'socket') p.holdSocketClose = true;
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (mode === 'hook') h.entity.hook('close', () => pending);
      if (mode === 'stop wedge') vi.spyOn(h.entity, 'stop').mockImplementationOnce(() => pending);
      if (mode === 'stop failure')
        vi.spyOn(h.entity, 'stop').mockRejectedValueOnce(new Error('stop failed'));
      const close = vi.spyOn(h.entity, '_closeStream');
      const ended = vi.fn();
      const begin = Date.now();
      const done = accountLifecycles.get(accountId)!.stop().then(ended);
      await flush();
      if (mode !== 'stop failure') {
        if (mode === 'stop wedge') expect(h.entity.stop).toHaveBeenCalledOnce();
        else expect(close).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(4999);
        expect(ended).not.toHaveBeenCalled();
        expect(p.sockets[0].destroyed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      await done;
      expect(Date.now() - begin).toBeLessThanOrEqual(5000);
      expect(p.sockets[0].destroyed).toBe(true);
      expect(p.sockets[0].eventNames()).toEqual([]);
      stoppedResources(h.entity);
      release();
      for (const complete of p.sockets[0].held) complete();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('T4 a rejected close hook cannot prevent the footer or escape as an unhandled error', async () => {
    const p = peer();
    const h = await start(p);
    h.entity.hook('close', async () => {
      throw new Error('hook failed');
    });
    const done = accountLifecycles.get(accountId)!.stop();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(p.sockets[0].writes).toContain('</stream:stream>');
    expect(p.sessions.size).toBe(0);
    stoppedResources(h.entity);
  });

  it.each(['wedge', 'failure'])(
    'T5 bounds one unavailable %s inside the total budget and still closes the stream',
    async (mode) => {
      const p = peer();
      const h = await start(p);
      h.entity.timeout = 30_000;
      p.holdPeerClose = true;
      if (mode === 'wedge') p.holdWrite = 'unavailable';
      else p.failUnavailable = true;
      const begin = Date.now();
      const done = accountLifecycles.get(accountId)!.stop();
      await flush();
      const writes = () => p.sockets[0].writes.filter((s) => s.includes('type="unavailable"'));
      expect(writes()).toHaveLength(1);
      if (mode === 'wedge') {
        await vi.advanceTimersByTimeAsync(249);
        expect(p.sockets[0].writes).not.toContain('</stream:stream>');
        await vi.advanceTimersByTimeAsync(1);
      }
      await flush();
      expect(p.sockets[0].writes).toContain('</stream:stream>');
      await vi.advanceTimersByTimeAsync(5000 - (Date.now() - begin));
      await done;
      expect(Date.now() - begin).toBe(5000);
      expect(writes()).toHaveLength(1);
      for (const complete of p.sockets[0].held) complete();
      await flush();
      expect(writes()).toHaveLength(1);
      stoppedResources(h.entity);
    }
  );

  it('T6 rejects activity, reconnect races and late socket attachment while the terminal stream is open', async () => {
    const p = peer();
    const h = await start(p);
    p.holdPeerClose = true;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    scheduleReconnect(accountId, h.ctx);
    const queuedReconnect = timers.mock.calls.at(-1)![0] as () => void;
    const done = accountLifecycles.get(accountId)!.stop();
    await flush();
    expect(p.sockets[0].writes).toContain('</stream:stream>');
    h.entity.emit('disconnect');
    h.entity.emit('offline');
    h.entity._onElement(
      xml(
        'error',
        { xmlns: STREAM },
        xml('see-other-host', { xmlns: 'urn:ietf:params:xml:ns:xmpp-streams' }, 'example.com:5223')
      )
    );
    scheduleReconnect(accountId, h.ctx);
    queuedReconnect(); // Already dequeued by the event loop before cancellation.
    h.entity._onSeeOtherHost({
      element: xml('error', {}, xml('see-other-host', {}, 'example.com:5223')),
    });
    for (const stanza of [
      xml('message'),
      xml('presence'),
      xml('iq'),
      xml('presence', { type: 'unavailable' }),
    ]) {
      await expect(h.entity.send(stanza)).rejects.toThrow();
    }
    await expect(h.entity.connect('xmpp://example.com:5222')).rejects.toThrow();
    await expect(h.entity.open(h.entity.options)).rejects.toThrow();
    await expect(h.entity.write('</stream:stream>')).rejects.toThrow();
    await h.entity._closeSocket();
    await h.entity.disconnect();
    expect(p.sockets[0].end).not.toHaveBeenCalled();
    const late = new WireSocket(p);
    expect(() => h.entity._attachSocket(late)).toThrow();
    expect(late.destroyed).toBe(true);
    expect(p.sockets[0].destroyed).toBe(false);
    expect(reconnectStates.size).toBe(0);
    p.sockets[0].releasePeerClose();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.events.filter((e) => e === 'connect')).toHaveLength(1);
    expect(construction.client).toHaveBeenCalledOnce();
  });

  it('T6 close hooks cannot use terminal context for application writes or a second unavailable', async () => {
    const p = peer();
    const h = await start(p);
    const attempted = vi.fn();
    h.entity.hook('close', async () => {
      for (const stanza of [
        xml('message'),
        xml('iq'),
        xml('presence'),
        xml('presence', { type: 'unavailable' }),
      ]) {
        await expect(h.entity.send(stanza)).rejects.toThrow();
        attempted();
      }
    });
    const done = accountLifecycles.get(accountId)!.stop();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(attempted).toHaveBeenCalledTimes(4);
    expect(p.events.filter((e) => e === 'write:unavailable')).toHaveLength(1);
    expect(p.events.filter((e) => e === 'write:sm-ack')).toHaveLength(1);
    expect(p.events.filter((e) => e === 'write:footer')).toHaveLength(1);
    expect(p.sessions.size).toBe(0);
  });

  it.each(['peer completes', 'deadline'])(
    'T7 replacement and gateway lifetime await terminal completion: %s',
    async (mode) => {
      const p = peer();
      const old = await start(p);
      old.entity.timeout = 30_000;
      p.holdPeerClose = true;
      const owner = accountLifecycles.get(accountId)!;
      const lifetimeEnded = vi.fn();
      void old.lifetime.then(lifetimeEnded);
      old.controller.abort(); // Gateway stop starts before its subsequent startAccount.
      const done = owner.stop();
      const next = await start(p);
      expect(lifetimeEnded).not.toHaveBeenCalled();
      expect(construction.client).toHaveBeenCalledOnce();
      expect(next.entity).toBeUndefined();
      if (mode === 'peer completes') {
        p.holdPeerClose = false;
        p.sockets[0].releasePeerClose();
      } else await vi.advanceTimersByTimeAsync(4980);
      await vi.advanceTimersByTimeAsync(20);
      await done;
      expect(lifetimeEnded).toHaveBeenCalledOnce();
      expect(construction.client).toHaveBeenCalledTimes(2);
      expect(next.entity).not.toBe(old.entity);
      expect(next.status.connected).toBe(true);
      const snapshot = { ...next.status };
      old.entity.emit('online', { toString: () => 'agent@example.com/old' });
      old.entity.streamManagement.emit('resumed');
      old.entity.emit('error', new Error('late failure'));
      await flush();
      expect(next.status).toEqual(snapshot);
      expect(activeClients.get(accountId)).toBe(next.entity);
    }
  );

  it('T8 concurrent repeated stops return one shared completion and close exactly once', async () => {
    const p = peer();
    const h = await start(p);
    p.holdPeerClose = true;
    const owner = accountLifecycles.get(accountId)!;
    const retired = vi.fn();
    h.entity.on('disconnect', () => {
      if (h.entity.status === 'offline') retired();
    });
    const first = owner.stop();
    const second = owner.stop();
    expect(second).toBe(first);
    await flush();
    expect(p.events.filter((e) => e === 'write:unavailable')).toHaveLength(1);
    expect(p.events.filter((e) => e === 'write:footer')).toHaveLength(1);
    p.sockets[0].releasePeerClose();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, second]);
    expect(owner.stop()).toBe(first);
    expect(p.sockets[0].end).toHaveBeenCalledOnce();
    expect(retired).toHaveBeenCalledOnce();
    expect(p.sockets[0].destroy.mock.calls.length).toBeLessThanOrEqual(1);
    stoppedResources(h.entity);
  });

  it('T9 sequential deliberate reloads leave no old resumable logical sessions', async () => {
    const p = peer();
    let h = await start(p);
    for (let i = 0; i < 6; i++) {
      const oldId = h.entity.streamManagement.id;
      h = await start(p);
      expect(p.sessions.size).toBe(1);
      expect([...p.sessions.values()].some((s) => s.id === oldId)).toBe(false);
      expect([...p.sessions.values()].some((s) => s.resumable)).toBe(false);
      expect(h.status.connected).toBe(true);
    }
    const socket = p.sockets.at(-1)!;
    socket.destroy();
    expect(p.sessions.size).toBe(1);
    expect([...p.sessions.values()][0].resumable).toBe(true);
  });

  it('T10 late application write completion cannot destroy the terminal socket or publish telemetry', async () => {
    const p = peer();
    const h = await start(p);
    p.holdWrite = 'message';
    p.holdPeerClose = true;
    const message = h.entity
      .send(xml('message', { to: 'user@example.com' }, xml('body', {}, 'pending')))
      .catch(() => {});
    await flush();
    expect(p.sockets[0].held).toHaveLength(1);
    const done = accountLifecycles.get(accountId)!.stop();
    await flush();
    expect(p.sockets[0].writes).toContain('</stream:stream>');
    const status = { ...h.status };
    p.sockets[0].held[0]();
    await message;
    await flush();
    expect(p.sockets[0].destroyed).toBe(false);
    expect(h.status).toEqual(status);
    expect(h.status.lastOutboundAt).toBeUndefined();
    p.sockets[0].releasePeerClose();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  });
});
