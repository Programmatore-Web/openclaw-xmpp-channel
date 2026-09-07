import type { Element, XmppClient } from '@xmpp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStartContext } from '../src/types.js';

const mocks = vi.hoisted(() => ({ client: vi.fn(), joinMuc: vi.fn() }));
vi.mock('@xmpp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xmpp/client')>()),
  client: mocks.client,
}));
vi.mock('../src/rooms.js', () => ({ joinMuc: mocks.joinMuc }));

import { startXmppConnection } from '../src/monitor.js';
import {
  activeClients,
  cleanupAccountState,
  keepaliveIntervals,
  pendingMucJoins,
  reconnectStates,
} from '../src/state.js';

const accountId = 'online-test';
const rooms = ['first@conference.example.com', 'second@conference.example.com'];
let controller: AbortController;
let connection: Promise<void> | undefined;
let releases: Array<() => void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

async function connect() {
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
  const xmpp = {
    status: 'offline',
    options: { service: 'xmpp://example.com:5222', domain: 'example.com' },
    on: vi.fn((event: string, handler: typeof online) => {
      if (event === 'online') {
        if (online) startupOnline = handler;
        else online = handler;
      }
    }),
    off: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(async () => startupOnline?.()),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn((stanza: Element) => {
      events.push(stanza.is('iq') ? 'carbons' : 'presence');
      return Promise.resolve();
    }),
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
  await Promise.resolve(); // Let the mocked start register connection cleanup.
  if (!online) throw new Error('online listener was not registered');
  log.info.mockClear();
  log.debug.mockClear();
  setStatus.mockClear();
  return { online, xmpp, log, setStatus, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  releases = [];
});

afterEach(async () => {
  try {
    for (const release of releases) release();
    await vi.advanceTimersByTimeAsync(0);
    controller?.abort();
    await connection;
    cleanupAccountState(accountId);
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    expect(activeClients.has(accountId)).toBe(false);
    expect(reconnectStates.has(accountId)).toBe(false);
    expect(pendingMucJoins.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    connection = undefined;
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('online listener lifecycle', () => {
  it('returns void, starts in the same turn and preserves the sequential online phases', async () => {
    const h = await connect();
    const carbons = deferred();
    const presence = deferred();
    const firstJoin = deferred();
    h.xmpp.send
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
    expect(h.events).toEqual(['online', 'keepalive', 'carbons']);
    expect(keepaliveIntervals.has(accountId)).toBe(true);
    expect(h.xmpp.send.mock.calls[0][0].getChild('enable', 'urn:xmpp:carbons:2')).toBeDefined();
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
    expect(h.xmpp.send).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    expect(activeClients.get(accountId)).toBe(replacement);
  });

  it.each(['carbons', 'presence'])(
    'continues through status and joins after %s failure',
    async (phase) => {
      const h = await connect();
      if (phase === 'presence') h.xmpp.send.mockResolvedValueOnce(undefined);
      h.xmpp.send.mockRejectedValueOnce(new Error(`${phase} failed`));
      expect(h.online({ toString: () => 'bot@example.com/resource' })).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.xmpp.send).toHaveBeenCalledTimes(2);
      expect(h.setStatus).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
      expect(mocks.joinMuc).toHaveBeenCalledTimes(2);
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
      expect(h.xmpp.send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
