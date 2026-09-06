import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XmppClient } from '@xmpp/client';

let reconnect: typeof import('../src/reconnect.js');
let state: typeof import('../src/state.js');
import type { GatewayStartContext, ResolvedXmppAccount } from '../src/types.js';

const accountId = 'reconnect-test';

function reconnectContext(): GatewayStartContext {
  const account: ResolvedXmppAccount = {
    accountId,
    enabled: true,
    config: { jid: 'bot@example.com', password: 'password' },
  };
  return {
    account,
    accountId,
    cfg: { channels: { xmpp: account.config } } as OpenClawConfig,
    setStatus: vi.fn(),
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules(); // Isolate the registered start function, including its absent state.
  state = await import('../src/state.js');
  reconnect = await import('../src/reconnect.js');
});

afterEach(() => {
  state.cleanupAccountState(accountId);
  try {
    expect(state.reconnectStates.size).toBe(0);
    expect(state.activeClients.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
  }
});

describe('reconnect timer lifecycle', () => {
  it('does not schedule a duplicate reconnect timer', () => {
    reconnect.initReconnectState(accountId);
    const ctx = reconnectContext();
    reconnect.scheduleReconnect(accountId, ctx);
    const firstTimer = state.reconnectStates.get(accountId)?.timer;

    reconnect.scheduleReconnect(accountId, ctx);

    expect(state.reconnectStates.get(accountId)?.timer).toBe(firstTimer);
    expect(state.reconnectStates.get(accountId)?.attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clears a live reconnect timer during account cleanup', () => {
    reconnect.initReconnectState(accountId);
    reconnect.scheduleReconnect(accountId, reconnectContext());
    expect(vi.getTimerCount()).toBe(1);

    state.cleanupAccountState(accountId);

    expect(state.reconnectStates.has(accountId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns void, clears the timer immediately and stops the stale client before starting', async () => {
    const fakeSetTimeout = globalThis.setTimeout;
    const callbacks: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay) => {
      const callback = vi.fn(handler as () => void);
      callbacks.push(callback);
      return fakeSetTimeout(callback, delay);
    });
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const events: string[] = [];
    const stop = vi.fn(() => {
      events.push('stop');
      return stopping;
    });
    const start = vi.fn(() => {
      events.push('start');
      return Promise.resolve();
    });
    state.activeClients.set(accountId, { stop } as unknown as XmppClient);
    reconnect.registerStartXmppConnection(start);
    reconnect.initReconnectState(accountId);
    const ctx = reconnectContext();
    const log = { info: vi.fn() };
    reconnect.scheduleReconnect(accountId, ctx, log);
    try {
      expect(state.reconnectStates.get(accountId)?.timer).toBeDefined();
      vi.advanceTimersByTime(state.RECONNECT_BASE_DELAY_MS);
      expect(callbacks[0].mock.results[0]).toEqual({ type: 'return', value: undefined });
      expect(state.reconnectStates.get(accountId)?.timer).toBeUndefined();
      expect(state.activeClients.has(accountId)).toBe(false);
      expect(events).toEqual(['stop']);
      expect(start).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenLastCalledWith(
        `[${accountId}] Attempting reconnect (attempt 1)...`
      );
      finishStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['stop', 'start']);
      expect(start).toHaveBeenCalledWith(ctx);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishStop();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('handles start rejection with the existing log and does not schedule another attempt', async () => {
    const start = vi.fn().mockRejectedValue(new Error('start failed'));
    const log = { error: vi.fn() };
    reconnect.registerStartXmppConnection(start);
    reconnect.initReconnectState(accountId);
    reconnect.scheduleReconnect(accountId, reconnectContext(), log);
    await vi.advanceTimersByTimeAsync(state.RECONNECT_BASE_DELAY_MS);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(`[${accountId}] Reconnect failed: start failed`);
    expect(state.reconnectStates.get(accountId)).toMatchObject({
      attempts: 1,
      nextDelayMs: state.RECONNECT_BASE_DELAY_MS * 2,
      timer: undefined,
    });
    await vi.advanceTimersByTimeAsync(state.RECONNECT_MAX_DELAY_MS * 2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the missing start registration behavior', async () => {
    const log = { error: vi.fn() };
    reconnect.initReconnectState(accountId);
    reconnect.scheduleReconnect(accountId, reconnectContext(), log);
    await vi.advanceTimersByTimeAsync(state.RECONNECT_BASE_DELAY_MS);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      `[${accountId}] startXmppConnection not registered for reconnect`
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['replaced', 'aborted'])(
    'preserves the %s state guard when the timer fires',
    async (change) => {
      const start = vi.fn().mockResolvedValue(undefined);
      const log = { debug: vi.fn() };
      reconnect.registerStartXmppConnection(start);
      reconnect.initReconnectState(accountId);
      reconnect.scheduleReconnect(accountId, reconnectContext(), log);
      if (change === 'replaced') reconnect.initReconnectState(accountId);
      else state.reconnectStates.get(accountId)!.aborted = true;
      await vi.advanceTimersByTimeAsync(state.RECONNECT_BASE_DELAY_MS);
      expect(start).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(`[${accountId}] Reconnect cancelled (aborted)`);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('bounds stale stop at five seconds while leaving the new connection lifetime pending', async () => {
    let finishStop!: () => void;
    let finishStart!: () => void;
    const stopping = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const lifetime = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const stop = vi.fn().mockReturnValue(stopping);
    const start = vi.fn().mockReturnValue(lifetime);
    const log = { warn: vi.fn(), error: vi.fn() };
    state.activeClients.set(accountId, { stop } as unknown as XmppClient);
    reconnect.registerStartXmppConnection(start);
    reconnect.initReconnectState(accountId);
    reconnect.scheduleReconnect(accountId, reconnectContext(), log);
    try {
      await vi.advanceTimersByTimeAsync(state.RECONNECT_BASE_DELAY_MS + 4999);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(log.warn).toHaveBeenCalledWith(
        `[${accountId}] Stale client stop exceeded 5000ms; abandoning it`
      );
      expect(start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(state.RECONNECT_MAX_DELAY_MS * 2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishStop();
      finishStart();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it.each(['attempt log', 'error log'])(
    'contains residual %s failure and a failing terminal logger',
    async (failure) => {
      const start = vi.fn().mockRejectedValue(new Error('start failed'));
      const log = {
        info: vi.fn((message: string) => {
          if (failure === 'attempt log' && message.includes('Attempting reconnect'))
            throw new Error('attempt log failed');
        }),
        error: vi.fn(() => {
          throw new Error('error log failed');
        }),
      };
      reconnect.registerStartXmppConnection(start);
      reconnect.initReconnectState(accountId);
      reconnect.scheduleReconnect(accountId, reconnectContext(), log);
      await vi.advanceTimersByTimeAsync(state.RECONNECT_BASE_DELAY_MS);
      expect(log.error).toHaveBeenCalledTimes(failure === 'attempt log' ? 1 : 2);
      expect(log.error).toHaveBeenLastCalledWith(
        `[${accountId}] Reconnect task failed: ${failure} failed`
      );
      expect(state.reconnectStates.get(accountId)?.timer).toBeUndefined();
      expect(state.reconnectStates.get(accountId)?.attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
