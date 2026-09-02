import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initReconnectState, scheduleReconnect } from '../src/reconnect.js';
import { cleanupAccountState, reconnectStates } from '../src/state.js';
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

beforeEach(() => {
  vi.useFakeTimers();
  cleanupAccountState(accountId);
});

afterEach(() => {
  cleanupAccountState(accountId);
  vi.useRealTimers();
});

describe('reconnect timer lifecycle', () => {
  it('does not schedule a duplicate reconnect timer', () => {
    initReconnectState(accountId);
    const ctx = reconnectContext();
    scheduleReconnect(accountId, ctx);
    const firstTimer = reconnectStates.get(accountId)?.timer;

    scheduleReconnect(accountId, ctx);

    expect(reconnectStates.get(accountId)?.timer).toBe(firstTimer);
    expect(reconnectStates.get(accountId)?.attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clears a live reconnect timer during account cleanup', () => {
    initReconnectState(accountId);
    scheduleReconnect(accountId, reconnectContext());
    expect(vi.getTimerCount()).toBe(1);

    cleanupAccountState(accountId);

    expect(reconnectStates.has(accountId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
