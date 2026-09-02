/**
 * XMPP Reconnection with Exponential Backoff
 *
 * Handles automatic reconnection when connection is lost
 */

import type { GatewayStartContext, Logger } from "./types.js";
import {
  activeClients,
  reconnectStates,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
} from "./state.js";

// Forward declaration - will be imported from monitor.ts
// This avoids circular dependency by using dynamic import
type StartXmppConnectionFn = (ctx: GatewayStartContext) => Promise<void>;

let startXmppConnectionFn: StartXmppConnectionFn | null = null;

/**
 * Register the startXmppConnection function to avoid circular import
 */
export function registerStartXmppConnection(fn: StartXmppConnectionFn): void {
  startXmppConnectionFn = fn;
}

/**
 * Initialize reconnect state for an account
 */
export function initReconnectState(accountId: string): void {
  reconnectStates.set(accountId, {
    attempts: 0,
    lastAttemptAt: 0,
    nextDelayMs: RECONNECT_BASE_DELAY_MS,
    aborted: false,
  });
}

/**
 * Clear reconnect state (on successful connection)
 */
export function clearReconnectState(accountId: string): void {
  const state = reconnectStates.get(accountId);
  if (state?.timer) clearTimeout(state.timer);
  reconnectStates.delete(accountId);
}

/**
 * Abort reconnection attempts for an account
 */
export function abortReconnect(accountId: string): void {
  const state = reconnectStates.get(accountId);
  if (state) {
    state.aborted = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }
}

/** How long to wait for a stale client to close before abandoning it. */
const STALE_STOP_TIMEOUT_MS = 5000;

/**
 * Stop and discard the client currently registered for an account.
 *
 * `activeClients.delete()` on its own only drops our reference: the
 * `@xmpp/client` instance stays alive with an open TCP socket. Reconnecting
 * without stopping it therefore leaks a socket per attempt against the server.
 * The stop is bounded so a wedged teardown can't stall the reconnect.
 */
async function stopStaleClient(accountId: string, log?: Logger): Promise<void> {
  const stale = activeClients.get(accountId);
  activeClients.delete(accountId);
  if (!stale) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(stale.stop()).catch((err) => {
        log?.warn?.(
          `[${accountId}] Stale client stop failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log?.warn?.(
            `[${accountId}] Stale client stop exceeded ${STALE_STOP_TIMEOUT_MS}ms; abandoning it`
          );
          resolve();
        }, STALE_STOP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Schedule a reconnection attempt with exponential backoff
 */
export function scheduleReconnect(accountId: string, ctx: GatewayStartContext, log?: Logger): void {
  const state = reconnectStates.get(accountId);
  if (!state || state.aborted) {
    log?.debug?.(`[${accountId}] Reconnect aborted or not initialized`);
    return;
  }

  if (state.timer) {
    log?.debug?.(`[${accountId}] Reconnect already scheduled`);
    return;
  }

  if (state.attempts >= RECONNECT_MAX_ATTEMPTS) {
    log?.error?.(
      `[${accountId}] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached, giving up`
    );
    ctx.setStatus?.({
      accountId,
      running: false,
      lastError: `Max reconnect attempts reached after ${state.attempts} tries`,
    });
    return;
  }

  const delay = Math.min(state.nextDelayMs, RECONNECT_MAX_DELAY_MS);
  state.attempts++;
  state.nextDelayMs = Math.min(state.nextDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  state.lastAttemptAt = Date.now();

  log?.info?.(
    `[${accountId}] Scheduling reconnect in ${delay}ms (attempt ${state.attempts}/${RECONNECT_MAX_ATTEMPTS})`
  );

  ctx.setStatus?.({
    accountId,
    reconnectAttempts: state.attempts,
    reconnectNextAt: Date.now() + delay,
  });

  state.timer = setTimeout(async () => {
    const currentState = reconnectStates.get(accountId);
    if (currentState !== state || currentState.aborted) {
      log?.debug?.(`[${accountId}] Reconnect cancelled (aborted)`);
      return;
    }
    state.timer = undefined;

    log?.info?.(`[${accountId}] Attempting reconnect (attempt ${state.attempts})...`);

    try {
      // Stop the old client before dropping the reference. Deleting the map
      // entry alone orphans the underlying @xmpp/client, which holds its TCP
      // socket open -- so every reconnect attempt leaked one connection to the
      // server. A server-side fault that keeps us reconnecting (e.g. STARTTLS
      // failing) would then exhaust the server's file descriptors.
      await stopStaleClient(accountId, log);

      // Start a fresh connection
      if (startXmppConnectionFn) {
        await startXmppConnectionFn(ctx);
      } else {
        log?.error?.(`[${accountId}] startXmppConnection not registered for reconnect`);
      }
    } catch (err) {
      log?.error?.(
        `[${accountId}] Reconnect failed: ${err instanceof Error ? err.message : String(err)}`
      );
      // Will trigger another reconnect via offline event
    }
  }, delay);
}
