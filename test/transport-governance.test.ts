import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xml } from '@xmpp/client';
import { governTransport } from '../src/transport.js';

const require = createRequire(import.meta.url);
const { default: Connection } = await import(require.resolve('@xmpp/connection'));
let sockets: Socket[];
let drivers: ReturnType<typeof governTransport>[];

class Socket extends EventEmitter {
  destroyed = false;
  connect = vi.fn();
  end = vi.fn();
  write = vi.fn((_data: string, callback: () => void) => callback());
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('close');
  });
  constructor() {
    super();
    sockets.push(this);
  }
}

function fixture() {
  const entity = new Connection({ service: 'xmpp://example.com:5222', domain: 'example.com' });
  entity.Socket = Socket;
  entity.Parser = EventEmitter;
  entity.socketParameters = () => ({});
  entity.footerElement = () => xml('stream');
  let current = true;
  const driver = governTransport(entity, () => current, vi.fn());
  drivers.push(driver);
  return {
    entity,
    driver,
    stale() {
      current = false;
      driver.dispose();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  drivers = [];
});
afterEach(async () => {
  for (const driver of drivers) driver.dispose();
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets.filter((socket) => !socket.destroyed)).toHaveLength(0);
  for (const socket of sockets) expect(socket.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('installed 0.14.0 connection primitive budgets', () => {
  it('cancels a real native connect wait and releases its socket listeners at the 2s budget', async () => {
    const h = fixture();
    const result = h.driver.run();
    const error = expect(result).rejects.toThrow('connect exceeded 2000ms');
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await error;
    expect(sockets[0].destroy).toHaveBeenCalledOnce();
    expect(h.entity.socket).toBeNull();
    expect(h.driver.reusable).toBe(false);
  });

  it.each(['timeout', 'replacement'])(
    'blocks a real late header write after %s without installing a new open timer',
    async (mode) => {
      const h = fixture();
      const result = h.driver.run();
      const error = expect(result).rejects.toThrow(
        mode === 'timeout' ? 'open exceeded' : 'cancelled'
      );
      const socket = sockets[0];
      let finish!: () => void;
      socket.write.mockImplementationOnce((_data, callback) => {
        finish = callback;
      });
      socket.emit('connect');
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.write).toHaveBeenCalledOnce();
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(2000);
      else h.stale();
      await error;
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.destroyed).toBe(true);
      expect(h.entity.listenerCount('open')).toBe(0);
      expect(h.entity.listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('bounds the native graceful footer write and makes its late completion harmless', async () => {
    const h = fixture();
    const ready = h.driver.run();
    const socket = sockets[0];
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    h.entity.emit('open', xml('stream'));
    await ready;
    let finish!: () => void;
    socket.write.mockImplementationOnce((_data, callback) => {
      finish = callback;
    });
    const closing = h.driver.close();
    // The write has no independent timeout; its owning close has a 5s budget.
    const settled = closing.catch(() => {});
    await vi.advanceTimersByTimeAsync(4999);
    expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(socket.destroyed).toBe(true);
    expect(socket.end).not.toHaveBeenCalled(); // No late _closeSocket after retirement.
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.end).not.toHaveBeenCalled();
    expect(h.entity.parser).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains a throwing destroy without producing a retry or an unhandled rejection', async () => {
    const h = fixture();
    const result = h.driver.run();
    const error = expect(result).rejects.toThrow('cancelled');
    sockets[0].destroy.mockImplementationOnce(() => {
      sockets[0].destroyed = true;
      sockets[0].emit('close');
      throw new Error('close failed');
    });
    expect(() => h.stale()).not.toThrow();
    await error;
    expect(h.entity.socket).toBeNull();
    expect(sockets[0].connect).toHaveBeenCalledOnce();
  });
});

describe('native parser and TLS wrapper cancellation', () => {
  it('cancels the native parser-end timer during an aborted graceful close', async () => {
    const h = fixture();
    const ready = h.driver.run();
    const socket = sockets[0];
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    h.entity.emit('open', xml('stream'));
    await ready;
    const closing = h.driver.close().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2); // Native parser-end wait and whole-close budget.
    h.stale();
    await closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroys the inner socket of the real 0.14.0 TLS wrapper, which has no destroy method', async () => {
    const { default: TlsSocket } = await import(require.resolve('@xmpp/tls/lib/Socket.js'));
    const h = fixture();
    h.entity.Socket = class extends TlsSocket {
      connect() {
        this._attachSocket(new Socket());
      }
    };
    const result = h.driver.run();
    const error = expect(result).rejects.toThrow('connect exceeded 2000ms');
    expect(h.entity.socket.destroy).toBeUndefined();
    const wrapper = h.entity.socket;
    const inner = sockets[0];
    await vi.advanceTimersByTimeAsync(2000);
    await error;
    expect(inner.destroy).toHaveBeenCalledOnce();
    expect(inner.destroyed).toBe(true);
    expect(wrapper.socket).toBeNull();
    expect(wrapper.eventNames()).toEqual([]);
  });
});

describe('R2 application write semantics', () => {
  it.each(['message', 'presence', 'iq'])(
    'does not give a delayed ordinary %s send a connection timeout',
    async (name) => {
      const h = fixture();
      const ready = h.driver.run();
      const socket = sockets[0];
      socket.emit('connect');
      await vi.advanceTimersByTimeAsync(0);
      h.entity.emit('open', xml('stream'));
      await ready;
      h.entity._status('online');
      let finish!: () => void;
      socket.write.mockImplementationOnce((_data, callback) => {
        finish = callback;
      });
      const success = vi.fn();
      const failure = vi.fn();
      const sending = h.entity.send(xml(name, { to: 'friend@example.com' })).then(success, failure);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.driver.reusable).toBe(true);
      expect(socket.destroyed).toBe(false);
      expect(h.entity.status).toBe('online');
      expect(success).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      finish();
      await sending;
      expect(success).toHaveBeenCalledOnce();
      expect(failure).not.toHaveBeenCalled();
    }
  );
});

describe('R2 protocol ownership and cancellation', () => {
  it('bounds a restarted stream header independently of application writes', async () => {
    const h = fixture();
    const ready = h.driver.run();
    const socket = sockets[0];
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    h.entity.emit('open', xml('stream'));
    await ready;
    let finish!: () => void;
    socket.write.mockImplementationOnce((_data, callback) => {
      finish = callback;
    });
    const restarting = h.entity.restart();
    const failure = expect(restarting).rejects.toThrow('open exceeded 2000ms');
    await vi.advanceTimersByTimeAsync(2000);
    await failure;
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.destroyed).toBe(true);
    expect(h.entity.listenerCount('open')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending application write on retirement without waiting for its callback', async () => {
    const h = fixture();
    const ready = h.driver.run();
    const socket = sockets[0];
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    h.entity.emit('open', xml('stream'));
    await ready;
    let finish!: () => void;
    socket.write.mockImplementationOnce((_data, callback) => {
      finish = callback;
    });
    const sent = vi.fn();
    h.entity.on('send', sent);
    const sending = h.entity.send(xml('message', { to: 'friend@example.com' }));
    const failure = expect(sending).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.destroyed).toBe(false);
    h.stale();
    await failure;
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
