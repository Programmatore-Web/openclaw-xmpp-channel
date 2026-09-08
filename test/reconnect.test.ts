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
  it.each(['resolved', 'rejected', 'wedged', 'absent'])(
    'makes exhausted recovery final and bounds terminal teardown: %s client',
    async (mode) => {
      const ctx = reconnectContext();
      const start = vi.fn().mockResolvedValue(undefined);
      const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const nativeReconnect = { stop: vi.fn() };
      const stop = vi.fn(() => {
        expect(state.activeClients.has(accountId)).toBe(false);
        expect(nativeReconnect.stop).toHaveBeenCalledTimes(1);
        // Simulate teardown events requesting recovery again synchronously.
        reconnect.scheduleReconnect(accountId, ctx, log);
        if (mode === 'wedged') return new Promise<void>(() => {});
        if (mode === 'rejected') return Promise.reject(new Error('stop failed'));
        return Promise.resolve();
      });
      if (mode !== 'absent') {
        state.activeClients.set(accountId, {
          stop,
          reconnect: nativeReconnect,
        } as unknown as XmppClient);
      }
      reconnect.registerStartXmppConnection(start);
      reconnect.initReconnectState(accountId);
      const exhausted = state.reconnectStates.get(accountId)!;
      exhausted.attempts = state.RECONNECT_MAX_ATTEMPTS;

      expect(reconnect.scheduleReconnect(accountId, ctx, log)).toBeUndefined();
      expect(state.activeClients.has(accountId)).toBe(false);
      expect(exhausted.aborted).toBe(true);
      expect(exhausted.timer).toBeUndefined();
      expect(exhausted.attempts).toBe(state.RECONNECT_MAX_ATTEMPTS);
      expect(ctx.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
          running: false,
          connected: false,
        })
      );
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'wedged') {
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(4999);
        expect(log.warn).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(log.warn).toHaveBeenCalledWith(
          `[${accountId}] Stale client stop exceeded 5000ms; abandoning it`
        );
      } else if (mode === 'rejected') {
        expect(log.warn).toHaveBeenCalledWith(
          `[${accountId}] Stale client stop failed: stop failed`
        );
      }
      expect(vi.getTimerCount()).toBe(0);
      reconnect.scheduleReconnect(accountId, ctx, log);
      await vi.advanceTimersByTimeAsync(state.RECONNECT_MAX_DELAY_MS * 2);
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(mode === 'absent' ? 0 : 1);
      expect(nativeReconnect.stop).toHaveBeenCalledTimes(mode === 'absent' ? 0 : 1);
      expect(state.activeClients.has(accountId)).toBe(false);
      expect(exhausted.timer).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('contains terminal teardown rejection even when terminal error reporting throws', async () => {
    const ctx = reconnectContext();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn(() => {
      throw new Error('stop threw');
    });
    const log = {
      error: vi.fn((message: string) => {
        if (message.includes('Terminal XMPP teardown failed')) throw new Error('logger failed');
      }),
    };
    state.activeClients.set(accountId, { stop } as unknown as XmppClient);
    reconnect.registerStartXmppConnection(start);
    reconnect.initReconnectState(accountId);
    state.reconnectStates.get(accountId)!.attempts = state.RECONNECT_MAX_ATTEMPTS;
    reconnect.scheduleReconnect(accountId, ctx, log);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenLastCalledWith(
      `[${accountId}] Terminal XMPP teardown failed: stop threw`
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(state.activeClients.has(accountId)).toBe(false);
    expect(state.reconnectStates.get(accountId)?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

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

  it.each(['abort', 'disable', 'state replacement', 'client replacement'])(
    'does not create a client after %s during stale teardown',
    async (mode) => {
      const ctx = reconnectContext();
      const controller = new AbortController();
      ctx.abortSignal = controller.signal;
      let finish!: () => void;
      const stop = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      const destroy = vi.fn();
      state.activeClients.set(accountId, { stop, socket: { destroy } } as unknown as XmppClient);
      const start = vi.fn().mockResolvedValue(undefined);
      reconnect.registerStartXmppConnection(start);
      reconnect.initReconnectState(accountId);
      reconnect.scheduleReconnect(accountId, ctx);
      await vi.advanceTimersByTimeAsync(state.RECONNECT_BASE_DELAY_MS);
      if (mode === 'abort') controller.abort();
      if (mode === 'disable') ctx.account.enabled = false;
      if (mode === 'state replacement') reconnect.initReconnectState(accountId);
      if (mode === 'client replacement') {
        state.activeClients.set(accountId, {
          stop: vi.fn().mockResolvedValue(undefined),
        } as unknown as XmppClient);
      }
      finish();
      await vi.advanceTimersByTimeAsync(state.RECONNECT_MAX_DELAY_MS * 2);
      expect(start).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

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
