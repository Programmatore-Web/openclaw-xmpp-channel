import type { XmppClient } from '@xmpp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startKeepalive, stopKeepalive } from '../src/keepalive.js';
import { KEEPALIVE_INTERVAL_MS, keepaliveIntervals } from '../src/state.js';

const accountId = 'keepalive-test';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  stopKeepalive(accountId);
  try {
    expect(keepaliveIntervals.has(accountId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('keepalive timer lifecycle', () => {
  it('returns void, sends XEP-0199 immediately, survives rejection and stops subsequent ticks', async () => {
    const fakeSetInterval = globalThis.setInterval;
    let tick = vi.fn();
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, delay) => {
      tick = vi.fn(handler as () => void);
      return fakeSetInterval(tick, delay);
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValue(undefined);
    const log = { debug: vi.fn(), warn: vi.fn() };
    startKeepalive({ send } as unknown as XmppClient, accountId, 'example.com', log);

    expect(vi.getTimerCount()).toBe(1);
    expect(keepaliveIntervals.has(accountId)).toBe(true);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), KEEPALIVE_INTERVAL_MS);
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
    expect(tick.mock.results[0]).toEqual({ type: 'return', value: undefined });
    expect(send).toHaveBeenCalledOnce();
    const ping = send.mock.calls[0][0];
    expect(ping.is('iq')).toBe(true);
    expect(ping.attrs).toEqual({
      type: 'get',
      to: 'example.com',
      id: `ping-${KEEPALIVE_INTERVAL_MS}`,
    });
    expect(ping.getChild('ping', 'urn:xmpp:ping')).toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(`[${accountId}] Keepalive ping failed: send failed`);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenCalledWith(`[${accountId}] XEP-0199 keepalive ping sent`);
    stopKeepalive(accountId);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows another tick while the previous send is still pending', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const send = vi.fn().mockReturnValue(pending);
    startKeepalive({ send } as unknown as XmppClient, accountId, 'example.com');
    try {
      vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('contains failures in both operational and terminal warning reporting', async () => {
    const send = vi.fn().mockRejectedValue(new Error('send failed'));
    const warn = vi.fn(() => {
      throw new Error('report failed');
    });
    startKeepalive({ send } as unknown as XmppClient, accountId, 'example.com', { warn });
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(`[${accountId}] Keepalive task failed: report failed`);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
