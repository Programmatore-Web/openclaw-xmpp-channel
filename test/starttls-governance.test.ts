import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xml } from '@xmpp/client';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:tls', async (original) => {
  const actual = await original<typeof import('node:tls')>();
  return { ...actual, default: { ...actual.default, connect: mocks.connect } };
});
import { governTransport } from '../src/transport.js';

const require = createRequire(import.meta.url);
const { default: Connection } = await import(require.resolve('@xmpp/connection'));
let drivers: ReturnType<typeof governTransport>[];
let sockets: Array<net.Socket | SecureSocket>;
class SecureSocket extends EventEmitter {
  destroyed = false;
  getProtocol = vi.fn(() => 'TLSv1.2');
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
  end() {}
  write(_data: string, callback: () => void) {
    callback();
  }
}
async function fixture(holdSend = false) {
  const raw = new net.Socket();
  sockets.push(raw);
  // A deterministic end that never completes the native close.
  raw.end = vi.fn(() => raw);
  const secure = new SecureSocket();
  mocks.connect.mockImplementation(() => {
    sockets.push(secure);
    return secure;
  });
  const entity = new Connection({ service: 'xmpp://example.com:5222', domain: 'example.com' });
  entity.connect = async () => {
    entity._attachSocket(raw);
    entity._status('connect');
  };
  const open = vi.fn(async () => {
    entity._status('open');
  });
  entity.open = open;
  let finishSend!: () => void;
  const send = vi.fn(() =>
    holdSend
      ? new Promise<void>((resolve) => {
          finishSend = resolve;
        })
      : Promise.resolve()
  );
  entity.send = send;
  const error = vi.fn();
  entity.on('error', error);
  const driver = governTransport(entity, () => true, vi.fn());
  drivers.push(driver);
  await driver.run();
  entity._onElement(
    xml(
      'features',
      { xmlns: 'http://etherx.jabber.org/streams' },
      xml('starttls', { xmlns: 'urn:ietf:params:xml:ns:xmpp-tls' })
    )
  );
  const proceed = async () => {
    entity._onElement(xml('proceed', { xmlns: 'urn:ietf:params:xml:ns:xmpp-tls' }));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { entity, driver, raw, secure, open, send, error, proceed, finishSend };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  drivers = [];
  sockets = [];
});
afterEach(async () => {
  for (const driver of drivers) driver.dispose();
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('STARTTLS transport ownership', () => {
  it('captures TLS before handshake, retains native certificate options, and restarts only after secureConnect', async () => {
    const h = await fixture();
    expect(h.send.mock.calls[0][0].name).toBe('starttls');
    expect(mocks.connect).not.toHaveBeenCalled();
    await h.proceed();
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ socket: h.raw, host: 'example.com' });
    expect(h.entity.isSecure()).toBe(false);
    expect(h.open).toHaveBeenCalledTimes(1);
    h.secure.emit('secureConnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.entity.isSecure()).toBe(true);
    expect(h.entity.socket).toBe(h.secure);
    expect(h.open).toHaveBeenCalledTimes(2);
    h.driver.dispose();
    expect(h.raw.destroyed).toBe(true);
    expect(h.secure.destroyed).toBe(true);
  });

  it.each(['before proceed', 'handshake', 'TLS 1.3 delay'])(
    'cancels upgrade at %s and makes late completion harmless',
    async (phase) => {
      const h = await fixture();
      if (phase !== 'before proceed') await h.proceed();
      if (phase === 'TLS 1.3 delay') {
        h.secure.getProtocol.mockReturnValue('TLSv1.3');
        h.secure.emit('secureConnect');
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
      }
      h.driver.dispose();
      expect(h.raw.destroyed).toBe(true);
      if (phase !== 'before proceed') expect(h.secure.destroyed).toBe(true);
      await h.proceed();
      h.secure.emit('secureConnect');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.open).toHaveBeenCalledTimes(1);
      expect(h.entity.socket).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.secure.eventNames()).toEqual([]);
      if (phase === 'before proceed') expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it('bounds a never-settling TLS handshake and destroys the unattached TLS socket', async () => {
    const h = await fixture();
    await h.proceed();
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.secure.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.secure.destroyed).toBe(true);
    expect(h.raw.destroyed).toBe(true);
    expect(h.driver.reusable).toBe(false);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains certificate failure without opening an authenticated stream', async () => {
    const h = await fixture();
    await h.proceed();
    h.secure.emit('error', new Error('CERT_HAS_EXPIRED'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'CERT_HAS_EXPIRED' }));
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.raw.destroyed).toBe(true);
    expect(h.secure.destroyed).toBe(true);
    expect(h.entity.isSecure()).toBe(false);
  });
});

describe('R2 STARTTLS negotiation deadline', () => {
  it.each(['response', 'send completion'])(
    'bounds a missing %s through the STARTTLS operation and ignores late completion',
    async (waitingFor) => {
      const h = await fixture(waitingFor === 'send completion');
      if (waitingFor === 'send completion') await h.proceed();
      await vi.advanceTimersByTimeAsync(1999);
      expect(h.raw.destroyed).toBe(false);
      expect(mocks.connect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.raw.destroyed).toBe(true);
      expect(h.driver.reusable).toBe(false);
      h.finishSend?.();
      await h.proceed();
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(h.open).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});

describe('R3 STARTTLS response namespace', () => {
  it.each([
    ['proceed', 'urn:example:wrong'],
    ['proceed', undefined],
    ['unexpected', 'urn:ietf:params:xml:ns:xmpp-tls'],
  ])('rejects %s in namespace %s before TLS or secure restart', async (name, xmlns) => {
    const h = await fixture();
    h.entity._onElement(xml(name!, xmlns ? { xmlns } : {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'STARTTLS_FAILURE' }));
    h.secure.emit('secureConnect');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.raw.destroyed).toBe(true);
    expect(h.entity.isSecure()).toBe(false);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls.map(([stanza]) => stanza.name)).toEqual(['starttls']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
