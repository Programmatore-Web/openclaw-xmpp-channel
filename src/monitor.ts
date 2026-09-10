/**
 * XMPP Connection Monitor
 *
 * Main entry point for XMPP connection management.
 * Handles connection lifecycle, message routing, and event dispatch.
 */

import { client, xml } from './xmpp.js';
import { assertXmppRuntimeCompatible } from './xmpp-runtime-compat.js';
import type { Element } from '@xmpp/client';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { createRunStateMachine } from 'openclaw/plugin-sdk/channel-lifecycle';
import type { XmppConfig, GatewayStartContext, XmppInboundMessage, Logger } from './types.js';
import { resolveConnectHost, extractJidDomain, extractUsername, bareJid } from './config-schema.js';
import { selectPasswordSaslMechanism } from './sasl.js';

// Import from split modules
import {
  activeClients,
  reconnectStates,
  sentMessageIds,
  accountLifecycles,
  clientDisposers,
  clearClientRoomState,
  type AccountLifecycle,
} from './state.js';
import { governTransport, TRANSPORT_CLOSE_BUDGET_MS } from './transport.js';
import { joinMuc } from './rooms.js';
import { startKeepalive, stopKeepalive } from './keepalive.js';
import {
  registerStartXmppConnection,
  initReconnectState,
  clearReconnectState,
  abortReconnect,
  scheduleReconnect,
} from './reconnect.js';
import { setupPresenceHandlers } from './stanza-handlers.js';
import { handleInboundMessage, handleInboundReaction } from './inbound.js';
import { clearMucOccupantIdentities } from './muc-identity.js';
import { createPresenceController, PRESENCE_STOP_BUDGET_MS } from './presence.js';

// =============================================================================
// RE-EXPORTS for backward compatibility
// =============================================================================

export { cleanupAccountState } from './state.js';
export { sendChatState, sendChatMarker } from './chat-state.js';

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate unique session ID for XMPP resource (prevents connection conflicts on restart)
 */
function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

interface StartableXmppClient {
  status: string;
  options: { service: string; domain: string; lang?: string };
  reconnect?: { stop(): void };
  connect(service: string): Promise<void>;
  open(options: { domain: string; lang?: string }): Promise<void>;
  disconnect(): Promise<void>;
  on(event: 'online', handler: () => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'disconnect', handler: () => void): void;
  off(event: 'online', handler: (address: { toString(): string }) => void): void;
  off(event: 'error', handler: (error: Error) => void): void;
  off(event: 'disconnect', handler: () => void): void;
}

/**
 * Start a client with one rejection owner for connect, stream open, and online.
 *
 * @xmpp/connection 0.14.0 creates its online Promise before awaiting a separate
 * open Promise. If one entity error rejects both, start() exposes the open
 * rejection but abandons the online rejection. Own the lower-level operations
 * here, rejecting startup directly on transport loss or cancellation.
 */
function startXmppClient(
  xmpp: ReturnType<typeof client>,
  isCurrent: () => boolean,
  signal: AbortSignal | undefined,
  handoff: AbortSignal,
  run: () => Promise<void>
): Promise<void> {
  const entity = xmpp as unknown as StartableXmppClient;

  return new Promise<void>((resolve, reject) => {
    if (entity.status !== 'offline') {
      reject(new Error('Connection is not offline'));
      return;
    }

    let settled = false;
    const cleanup = () => {
      entity.off('online', onOnline);
      entity.off('error', onError);
      entity.off('disconnect', onDisconnect);
      signal?.removeEventListener('abort', onAbort);
      handoff.removeEventListener('abort', onHandoff);
    };
    const settle = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      complete();
    };
    const onOnline = () => settle(resolve);
    const onError = (error: Error) => settle(() => reject(error));
    const onDisconnect = () => onError(new Error('XMPP disconnected before online'));
    const onAbort = () => onError(new Error('XMPP startup cancelled'));
    // Redirect governance takes over both success and failure. Release this
    // waiter's listeners before its intentional disconnect can reject startup.
    const onHandoff = () => settle(resolve);

    entity.on('online', onOnline);
    entity.on('error', onError);
    entity.on('disconnect', onDisconnect);
    signal?.addEventListener('abort', onAbort, { once: true });
    handoff.addEventListener('abort', onHandoff, { once: true });
    if (!isCurrent()) {
      onAbort();
      return;
    }

    void run().catch((error: unknown) =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error))))
    );
  });
}

interface StreamElement extends Element {
  is(name: string, xmlns?: string): boolean;
}

interface StreamManagementClient {
  streamManagement?: { enabled: boolean; enableSent: boolean };
  on(event: 'element' | 'nonza' | 'disconnect', handler: (element: StreamElement) => void): void;
  off(event: 'element' | 'nonza' | 'disconnect', handler: (element: StreamElement) => void): void;
}

/**
 * In xmpp.js 0.14.0 resource binding emits online before SM sends enable.
 * Neither false/false at online nor the raw enabled nonza proves readiness:
 * the library must first process its negotiation response. It emits no enabled
 * event, so inspect its state every 10ms. The 10s deadline only fails closed;
 * it never authorizes traffic based on elapsed time. An advertised absence of
 * SM (or an absent client module) needs no grace period.
 */
function waitForStreamManagement(
  entity: StreamManagementClient,
  advertised: boolean | undefined,
  signal: AbortSignal,
  isCurrent: () => boolean
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let failed = false;
    const finish = (ready: boolean, error?: Error) => {
      clearInterval(poll);
      clearTimeout(deadline);
      entity.off('nonza', onNonza);
      signal.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(ready);
      }
    };
    const onAbort = () => finish(false);
    const onNonza = (element: StreamElement) => {
      if (element.is('failed', 'urn:xmpp:sm:3')) {
        failed = true;
      }
    };
    const check = () => {
      const sm = entity.streamManagement;
      if (signal.aborted || !isCurrent()) {
        finish(false);
      } else if (!sm || sm.enabled || ((advertised === false || failed) && !sm.enableSent)) {
        finish(true);
      } else {
        return false;
      }
      return true;
    };

    entity.on('nonza', onNonza);
    signal.addEventListener('abort', onAbort, { once: true });
    const poll = setInterval(check, 10);
    // Generous negotiation budget, bounded independently of keepalive traffic.
    const deadline = setTimeout(() => {
      if (!check()) {
        finish(false, new Error('XEP-0198 negotiation did not settle within 10000ms'));
      }
    }, 10_000);
    check();
  });
}

/**
 * Get active client for an account
 */
export function getActiveClient(accountId: string): ReturnType<typeof client> | undefined {
  return activeClients.get(accountId);
}

// =============================================================================
// MAIN CONNECTION FUNCTION
// =============================================================================

/**
 * Start XMPP connection for an account
 * Returns a promise that stays pending until the connection is stopped
 */
export async function startXmppConnection(ctx: GatewayStartContext): Promise<void> {
  const accountId = ctx.accountId ?? ctx.account.accountId ?? 'default';
  if (!ctx.account.config.jid || !ctx.account.config.password) {
    throw new Error('XMPP jid and password are required');
  }
  const previous = accountLifecycles.get(accountId);
  const stopped = previous?.stop();
  let finish!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  let stopping: Promise<void> | undefined;
  const owner: AccountLifecycle = {
    ctx,
    start: () => (ended ? Promise.resolve() : startClient(ctx, owner)),
    stop() {
      if (stopping) {
        return stopping;
      }
      let complete!: () => void;
      stopping = new Promise<void>((resolve) => {
        complete = resolve;
      });
      ended = true;
      ctx.abortSignal?.removeEventListener('abort', onAbort);
      const current = accountLifecycles.get(accountId) === owner;
      const active = activeClients.get(accountId);
      const ownsState = !active || clientDisposers.get(active) === owner.disposeClient;
      owner.runState?.deactivate();
      if (current && ownsState) {
        abortReconnect(accountId);
      }
      const closing = owner.disposeClient?.(true);
      owner.disposeClient = undefined;
      if (current) {
        if (ownsState) {
          clearReconnectState(accountId);
          stopKeepalive(accountId);
          clearClientRoomState(accountId);
          try {
            ctx.setStatus?.({
              accountId,
              running: false,
              connected: false,
              reconnectNextAt: null,
              reconnectPending: false,
              lastStopAt: Date.now(),
            });
          } catch {
            /* Termination remains final if status reporting fails. */
          }
        }
      }
      const finishStop = () => {
        if (accountLifecycles.get(accountId) === owner) {
          accountLifecycles.delete(accountId);
        }
        finish();
        complete();
      };
      // Retain ownership until cleanup completes, even when Gateway aborts
      // before starting its replacement. An owner stopped while waiting for a
      // predecessor also carries that predecessor's bounded completion.
      void Promise.all([stopped, closing]).then(finishStop, finishStop);
      return stopping;
    },
  };
  const onAbort = () => {
    void owner.stop();
  };
  accountLifecycles.set(accountId, owner);
  owner.runState = createRunStateMachine({
    abortSignal: ctx.abortSignal,
    setStatus: (patch) => {
      if (!ended && accountLifecycles.get(accountId) === owner) {
        ctx.setStatus?.({ accountId, ...patch });
      }
    },
  });
  ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (stopped) {
    await stopped;
  }
  if (!ended && accountLifecycles.get(accountId) === owner) {
    if (!reconnectStates.has(accountId) || reconnectStates.get(accountId)?.aborted) {
      initReconnectState(accountId);
    }
    try {
      await owner.start();
    } catch (error) {
      await owner.stop();
      throw error;
    }
  }
  if (ctx.abortSignal?.aborted || !ctx.account.enabled) {
    await owner.stop();
  }
  return lifetime;
}

/** Create one client; replacement never waits on or retains another account lifetime. */
async function startClient(ctx: GatewayStartContext, owner: AccountLifecycle): Promise<void> {
  assertXmppRuntimeCompatible();
  const { account, cfg, abortSignal, log } = ctx;
  const accountId = ctx.accountId ?? account.accountId ?? 'default';
  const config = account.config;
  if (!config.jid || !config.password) {
    throw new Error('XMPP jid and password are required');
  }
  let disposed = false;
  const setStatus: GatewayStartContext['setStatus'] = (patch) => {
    if (!disposed && accountLifecycles.get(accountId) === owner) {
      ctx.setStatus?.(patch);
    }
  };

  const jidDomain = extractJidDomain(config.jid);
  const connectHost = resolveConnectHost(config);
  const username = extractUsername(config.jid);

  // Generate unique resource per session to prevent connection conflicts on restart
  const sessionResource = config.resource ?? `openclaw-${generateSessionId()}`;

  // Nickname is what users see in group chats
  const nickname = config.nickname ?? username;

  log?.info?.(
    `[${accountId}] Starting XMPP connection to ${connectHost} for domain ${jidDomain} (resource=${sessionResource}, nickname=${nickname})...`
  );

  // Mark as starting
  if (setStatus) {
    log?.debug?.(`[${accountId}] setStatus: running=true`);
    setStatus({
      accountId,
      running: true,
      terminalDisconnect: undefined,
      lastStartAt: Date.now(),
      lastError: null,
    });
  } else {
    log?.error?.(`[${accountId}] XMPP ERROR: setStatus function not provided by OpenClaw!`);
  }

  const xmpp = client({
    service: owner.service ?? `xmpp://${connectHost}:${config.port ?? 5222}`,
    domain: jidDomain,
    username,
    credentials: async (authenticate, mechanisms, _fast, entity) => {
      if (!entity.isSecure()) {
        throw new Error('STARTTLS is required before XMPP authentication');
      }

      const mechanism = selectPasswordSaslMechanism(mechanisms);

      await authenticate({ username, password: config.password }, mechanism);
    },
    resource: sessionResource,
  });

  // @xmpp/reconnect 0.14.0 installs a fixed-delay disconnect listener at creation.
  // The plugin owns ALL retry timers. Stopping this scheduler does not stop the
  // entity or clear SM state; connect/open below preserve the native resume path.
  const entity = xmpp as unknown as StartableXmppClient;
  entity.reconnect?.stop();

  // Store client for outbound messaging
  activeClients.set(accountId, xmpp);

  const smClient = xmpp as unknown as StreamManagementClient;
  let smAdvertised: boolean | undefined;
  let onlineGeneration = 0;
  let onlineAbort: AbortController | undefined;
  let onlineReady: Promise<boolean> | undefined;
  let established = false;
  let sessionReady = false;
  let retrying = false;
  let redirectFailed = false;
  let protocolPending = false;
  let negotiationTimer: ReturnType<typeof setTimeout> | undefined;
  const startupHandoff = new AbortController();

  const isActive = () =>
    !disposed &&
    accountLifecycles.get(accountId) === owner &&
    activeClients.get(accountId) === xmpp &&
    !abortSignal?.aborted &&
    account.enabled &&
    !reconnectStates.get(accountId)?.aborted;
  const cancelOnline = () => {
    sessionReady = false;
    presence.suspend();
    clearTimeout(negotiationTimer);
    negotiationTimer = undefined;
    onlineGeneration++;
    onlineAbort?.abort();
    if (activeClients.get(accountId) === xmpp) {
      stopKeepalive(accountId);
    }
  };
  const onStreamElement = (element: StreamElement) => {
    if (element.is('features', 'http://etherx.jabber.org/streams')) {
      protocolPending = true;
      smAdvertised = Boolean(element.getChild('sm', 'urn:xmpp:sm:3'));
    }
  };
  const onDisconnect = () => {
    cancelOnline();
    smAdvertised = undefined;
    // Resource binding on the next stream must be able to send its own IQ.
    onlineReady = undefined;
    if (protocolPending) {
      protocolPending = false;
      // Native SM procedure listeners are not cancelled by disconnect. Never
      // expose the next stream to an unfinished procedure from the old stream.
      transport.retire();
    }
    if (!isActive()) {
      return;
    }
    setStatus?.({ accountId, connected: false, lastDisconnect: { at: Date.now() } });
    if (!retrying) {
      scheduleReconnect(accountId, ctx, log, sameClientReconnect);
    }
  };
  const sameClientReconnect = {
    client: xmpp,
    canReuse: () => established && transport.reusable,
    async run(redirected = false) {
      if (!isActive() || retrying) {
        return;
      }
      retrying = true;
      redirectFailed = false;
      beginNegotiation();
      try {
        await transport.run(reconnectService, redirected);
      } catch (err) {
        if (!isActive()) {
          return;
        }
        cancelOnline();
        setStatus?.({
          accountId,
          connected: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
        try {
          await transport.close();
        } catch {
          /* Timed-out entities are replaced. */
        }
      } finally {
        retrying = false;
        if (
          isActive() &&
          (redirectFailed || !transport.reusable || entity.status === 'disconnect')
        ) {
          scheduleReconnect(accountId, ctx, log, sameClientReconnect);
        }
      }
    },
  };
  let reconnectService = entity.options.service;
  const transport = governTransport(xmpp, isActive, (service) => {
    // Initial redirects remain in the same governed connection attempt. The
    // startup waiter must neither schedule a retry nor clear its new deadline.
    // Invalid targets also transfer failure ownership here, exactly once.
    startupHandoff.abort();
    if (service !== undefined) {
      reconnectService = service;
      owner.service = service;
    } else {
      redirectFailed = true;
    }
    cancelOnline();
    setStatus?.({ accountId, connected: false, lastDisconnect: { at: Date.now() } });
    // Existing recovery keeps its delay/attempt count and uses the redirected
    // service. A healthy current stream may redirect immediately, serially.
    if (retrying || reconnectStates.get(accountId)?.timer) {
      void transport.close().catch(() => {});
      return;
    }
    retrying = true;
    void (async () => {
      try {
        await transport.close();
      } catch {
        /* Schedule replacement below. */
      }
      retrying = false;
      if (!isActive()) {
        return;
      }
      if (redirectFailed || !transport.reusable) {
        scheduleReconnect(accountId, ctx, log, sameClientReconnect);
      } else {
        await sameClientReconnect.run(true);
      }
    })().catch((err: unknown) => {
      if (isActive()) {
        setStatus?.({ accountId, lastError: String(err) });
        scheduleReconnect(accountId, ctx, log, sameClientReconnect);
      }
    });
  });
  const beginNegotiation = () => {
    clearTimeout(negotiationTimer);
    // Same deadline as the existing SM readiness gate, covering a stream that
    // never reaches either online or resumed after connect/open succeeded.
    negotiationTimer = setTimeout(() => {
      negotiationTimer = undefined;
      if (!isActive()) {
        return;
      }
      established = false;
      setStatus?.({
        accountId,
        connected: false,
        lastError: 'XMPP session negotiation exceeded 10000ms',
      });
      transport.retire();
      scheduleReconnect(accountId, ctx, log, sameClientReconnect);
    }, 10_000);
  };
  smClient.on('element', onStreamElement);
  smClient.on('disconnect', onDisconnect);

  // Also gate sends from outbound adapters and stanza handlers during online
  // initialization. Protocol nonzas and pre-online resource binding pass through.
  const send = xmpp.send.bind(xmpp);
  const presence = createPresenceController({
    xmpp,
    ctx,
    isCurrent: isActive,
    isOnline: () => entity.status === 'online',
    send,
  });
  xmpp.send = async (stanza) => {
    if (!isActive()) {
      throw new Error('XMPP client is no longer current');
    }
    const generation = onlineGeneration;
    if (onlineReady && ['iq', 'message', 'presence'].includes(stanza.name)) {
      if (!(await onlineReady) || generation !== onlineGeneration || !isActive()) {
        throw new Error('XMPP online initialization was cancelled');
      }
    }
    // All text delivery paths (including core-routed replies and sendText) use
    // this client. The inbound dispatcher callback is not their shared owner.
    const visible = stanza.name === 'message' && Boolean(stanza.getChildText('body')?.trim());
    try {
      await send(stanza);
    } catch (err) {
      if (visible && isActive()) {
        try {
          setStatus?.({ accountId, lastError: err instanceof Error ? err.message : String(err) });
        } catch {
          // Status telemetry must not mask the original transport failure.
        }
      }
      throw err;
    }
    if (visible && isActive()) {
      try {
        setStatus?.({ accountId, lastOutboundAt: Date.now() });
      } catch {
        // Status telemetry must not turn a delivered message into a retry.
      }
    }
  };

  // XEP-0198 Stream Management event handlers
  const streamManagement = (
    xmpp as unknown as {
      streamManagement?: {
        on?: (event: string, handler: (stanza?: Element) => void) => void;
        off?: (event: string, handler: (stanza?: Element) => void) => void;
      };
    }
  ).streamManagement;
  const smListeners: Array<() => void> = [];
  const onSm = (event: string, handler: (stanza?: Element) => void) => {
    streamManagement?.on?.(event, handler);
    smListeners.push(() => streamManagement?.off?.(event, handler));
  };

  if (streamManagement && typeof streamManagement.on === 'function') {
    onSm('resumed', () => {
      if (!isActive()) {
        return;
      }
      // xmpp.js resumes without emitting online again; SM is already enabled.
      cancelOnline();
      onlineReady = Promise.resolve(true);
      sessionReady = true;
      established = true;
      protocolPending = false;
      transport.resetRedirects();
      clearReconnectState(accountId);
      initReconnectState(accountId);
      startKeepalive(xmpp, accountId, jidDomain, log);
      log?.info?.(`[${accountId}] XEP-0198 Stream Management: session resumed`);
      setStatus?.({
        accountId,
        running: true,
        connected: true,
        lastConnectedAt: Date.now(),
        reconnectAttempts: 0,
        reconnectNextAt: null,
        reconnectPending: false,
        lastError: null,
      });
      // xmpp.js emits resumed immediately before _ready(true) sets online.
      void Promise.resolve().then(() => presence.ready(false));
    });

    onSm('fail', (stanza) => {
      log?.warn?.(
        `[${accountId}] XEP-0198 Stream Management: stanza failed to send: ${stanza?.toString()?.slice(0, 100)}`
      );
    });

    onSm('ack', () => {
      log?.debug?.(`[${accountId}] XEP-0198 Stream Management: stanza acknowledged`);
    });
  }

  // Setup message stanza handler
  const disposeMessages = setupMessageHandler(
    xmpp,
    accountId,
    nickname,
    cfg,
    config,
    log,
    setStatus,
    owner.runState
  );

  // Setup presence handlers (fail-closed subscriptions, MUC identity/presence)
  const disposePresence = setupPresenceHandlers(xmpp, accountId, log, presence.handle);

  // Connection events
  const onOnline = (address: { toString(): string }): void => {
    let generation = onlineGeneration;
    void (async () => {
      if (!isActive()) {
        return;
      }
      cancelOnline();
      presence.reset();
      // Native resumed does not emit online. This is a fresh logical session,
      // even on the same entity: old MUC observations cannot authorize traffic
      // during readiness or before new real-JID-bearing presence arrives.
      clearClientRoomState(accountId);
      generation = onlineGeneration;
      const isCurrent = () => isActive() && generation === onlineGeneration;
      log?.info?.(`[${accountId}] XMPP online as ${address.toString()}`);

      onlineAbort = new AbortController();
      onlineReady = waitForStreamManagement(smClient, smAdvertised, onlineAbort.signal, isCurrent);
      try {
        if (!(await onlineReady) || !isCurrent()) {
          return;
        }
      } catch (err) {
        if (!isCurrent()) {
          return;
        }
        established = false;
        // Plugin backoff owns recovery, including its bounded stale-client stop.
        // Do not create another teardown task or await a potentially wedged stop.
        scheduleReconnect(accountId, ctx, log, sameClientReconnect);
        throw err;
      }

      // Resource-binding online alone is not success: preserve attempts/backoff
      // until the SM gate has settled for this current, unaborted generation.
      clearReconnectState(accountId);
      initReconnectState(accountId);
      sessionReady = true;
      established = true;
      protocolPending = false;
      transport.resetRedirects();
      setStatus?.({
        accountId,
        reconnectAttempts: 0,
        reconnectNextAt: null,
        reconnectPending: false,
      });

      // Start XEP-0199 keepalive pings
      startKeepalive(xmpp, accountId, jidDomain, log);

      if (!isCurrent()) {
        return;
      }
      // SM readiness is the shared prerequisite. Presence reconciliation starts
      // independently of optional Carbons; only global presence waits for roster
      // authorization. Messaging, connected status and MUC do not await either.
      void presence.ready(true);

      if (!isCurrent()) {
        return;
      }

      // One best-effort Carbons attempt per fresh session, never on SM resume.
      // Ordinary send() has no deadline and cannot be cancelled by a wait budget.
      // Its settlement owns only current-generation diagnostics, no next phase.
      void (async () => {
        try {
          const enableCarbons = xml(
            'iq',
            { type: 'set', id: `carbons-${Date.now()}` },
            xml('enable', { xmlns: 'urn:xmpp:carbons:2' })
          );
          await xmpp.send(enableCarbons);
          if (isCurrent()) {
            log?.debug?.(`[${accountId}] XEP-0280 Message Carbons enable sent`);
          }
        } catch (err) {
          if (isCurrent()) {
            log?.warn?.(
              `[${accountId}] Failed to enable carbons: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      })().catch(() => {
        // Optional diagnostic failures cannot escape into lifecycle/status handling.
      });

      // Mark as connected
      setStatus?.({
        accountId,
        running: true,
        connected: true,
        lastConnectedAt: Date.now(),
        lastError: null,
      });

      // Join only rooms explicitly declared in this account's configuration.
      // A failed join is non-fatal: contain it locally so a later reconnect can retry.
      try {
        if (config.groups && config.groups.length > 0) {
          log?.info?.(`[${accountId}] Joining ${config.groups.length} group rooms...`);
          for (const room of config.groups) {
            if (!isCurrent()) {
              return;
            }
            await joinMuc(xmpp, room, nickname, log, accountId, true, onlineAbort?.signal);
          }
        } else {
          log?.debug?.(`[${accountId}] No group rooms configured`);
        }
      } catch (err) {
        if (isCurrent()) {
          log?.warn?.(
            `[${accountId}] Room (re)join interrupted (non-fatal, will retry on reconnect): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    })().catch((err) => {
      if (!isActive() || generation !== onlineGeneration) {
        return;
      }
      try {
        log?.error?.(
          `[${accountId}] XMPP online task failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } catch {
        // Contain terminal reporting failures without retrying or rethrowing.
      }
      try {
        setStatus?.({ accountId, lastError: err instanceof Error ? err.message : String(err) });
      } catch {
        // Status reporting is independent and best-effort at this boundary.
      }
    });
  };
  xmpp.on('online', onOnline);

  const onOffline = () => {
    established = false;
    onDisconnect();
    if (!isActive()) {
      return;
    }
    log?.info?.(`[${accountId}] XMPP offline`);

    stopKeepalive(accountId);
    clearMucOccupantIdentities(accountId);

    setStatus?.({
      accountId,
      running: true,
      connected: false,
      lastDisconnect: { at: Date.now() },
    });

    const reconnectState = reconnectStates.get(accountId);
    if (!reconnectState?.aborted) {
      scheduleReconnect(accountId, ctx, log, sameClientReconnect);
    }
  };
  xmpp.on('offline', onOffline);

  const onError = (err: Error) => {
    if (!isActive()) {
      return;
    }
    log?.error?.(`[${accountId}] XMPP error: ${err.message}`);
    setStatus?.({ accountId, lastError: err.message });
  };
  xmpp.on('error', onError);

  // Register disposal before starting any asynchronous operation. Replacement,
  // abort and state cleanup all use this same idempotent path.
  let disposal: Promise<void> | undefined;
  const dispose = (graceful = false): Promise<void> => {
    if (disposal) {
      return disposal;
    }
    let complete!: () => void;
    disposal = new Promise<void>((resolve) => {
      complete = resolve;
    });
    // Deliberate stop may already have an aborted signal or disabled account.
    // Ownership and the actual online stream, not operational mode, decide this.
    const canCloseStream =
      graceful &&
      entity.status === 'online' &&
      accountLifecycles.get(accountId) === owner &&
      activeClients.get(accountId) === xmpp;
    // Native online precedes monitor readiness. That stream still needs a
    // logical close even when terminal unavailable is not yet eligible.
    const sendOffline = canCloseStream && sessionReady && established;
    disposed = true;
    startupHandoff.abort();
    cancelOnline();
    smClient.off('element', onStreamElement);
    smClient.off('disconnect', onDisconnect);
    for (const remove of smListeners) {
      remove();
    }
    entity.off('online', onOnline);
    xmpp.off('offline', onOffline);
    entity.off('error', onError);
    xmpp.send = send;
    disposeMessages();
    disposePresence();
    presence.dispose();
    clientDisposers.delete(xmpp);
    if (owner.disposeClient === dispose) {
      owner.disposeClient = undefined;
    }
    if (activeClients.get(accountId) === xmpp) {
      activeClients.delete(accountId);
    }
    if (accountLifecycles.get(accountId) === owner && !activeClients.has(accountId)) {
      stopKeepalive(accountId);
      clearClientRoomState(accountId);
    }
    const terminal = canCloseStream ? transport.beginShutdown() : undefined;
    let finished = false;
    const finishDispose = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      // The deadline must release the actual transport before lifetime completion.
      transport.dispose();
      complete();
    };
    const timer = setTimeout(() => {
      try {
        log?.warn?.(
          `[${accountId}] Stale client stop exceeded ${TRANSPORT_CLOSE_BUDGET_MS}ms; abandoning it`
        );
      } catch {
        /* Teardown completion must not depend on logging. */
      }
      finishDispose();
    }, TRANSPORT_CLOSE_BUDGET_MS);
    if (!terminal) {
      transport.dispose();
    }
    let offline: Promise<void> | undefined;
    if (terminal && sendOffline) {
      offline = new Promise<void>((resolve) => {
        const presenceTimer = setTimeout(resolve, PRESENCE_STOP_BUDGET_MS);
        try {
          void terminal
            .unavailable(() => send(xml('presence', { type: 'unavailable' })))
            .catch(() => {})
            .finally(() => {
              clearTimeout(presenceTimer);
              resolve();
            });
        } catch {
          clearTimeout(presenceTimer);
          resolve();
        }
      });
    }
    void Promise.resolve(offline)
      .then(() => {
        if (!finished) {
          return terminal ? terminal.stop(() => xmpp.stop()) : xmpp.stop();
        }
      })
      .catch((err: unknown) => {
        try {
          log?.warn?.(
            `[${accountId}] Stale client stop failed: ${err instanceof Error ? err.message : String(err)}`
          );
        } catch {
          /* Contain stop and reporting failures together. */
        }
      })
      .finally(finishDispose);
    return disposal;
  };
  clientDisposers.set(xmpp, dispose);
  owner.disposeClient = dispose;

  try {
    beginNegotiation();
    await startXmppClient(xmpp, isActive, abortSignal, startupHandoff.signal, () =>
      transport.run()
    );
    if (!startupHandoff.signal.aborted) {
      clearTimeout(negotiationTimer);
      negotiationTimer = undefined;
    }
  } catch (err) {
    if (startupHandoff.signal.aborted) {
      return;
    }
    clearTimeout(negotiationTimer);
    negotiationTimer = undefined;
    log?.error?.(
      `[${accountId}] XMPP connection failed: ${err instanceof Error ? err.message : String(err)}`
    );
    if (isActive()) {
      setStatus?.({
        accountId,
        connected: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
      scheduleReconnect(accountId, ctx, log, sameClientReconnect);
    }
  }
}

registerStartXmppConnection((ctx) => {
  const accountId = ctx.accountId ?? ctx.account.accountId ?? 'default';
  const owner = accountLifecycles.get(accountId);
  return owner?.ctx === ctx ? owner.start() : Promise.resolve();
});

// =============================================================================
// MESSAGE STANZA HANDLER
// =============================================================================

/** Detect unsupported application-layer encrypted message payloads. */
export function hasUnsupportedEncryptedPayload(stanza: Element): boolean {
  return Boolean(stanza.getChild('encryption', 'urn:xmpp:eme:0') ?? stanza.getChild('encrypted'));
}

export function setupMessageHandler(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  nickname: string,
  cfg: OpenClawConfig,
  config: XmppConfig,
  log?: Logger,
  setStatus?: GatewayStartContext['setStatus'],
  runState?: AccountLifecycle['runState']
): () => void {
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const mappings = new Map<string, string>();
  const onStanza = (stanza: Element): void => {
    if (disposed) {
      return;
    }
    void (async () => {
      try {
        log?.debug?.(`[${accountId}] XMPP stanza received: attrs=${JSON.stringify(stanza.attrs)}`);

        if (!stanza.is('message')) {
          return;
        }

        const mediatedInvite = stanza
          .getChild('x', 'http://jabber.org/protocol/muc#user')
          ?.getChild('invite');
        const directInvite = stanza.getChild('x', 'jabber:x:conference');
        if (mediatedInvite || directInvite) {
          log?.info?.(`[${accountId}] Ignoring unsolicited MUC invitation`);
          return;
        }

        // Early check for MUC self-messages.
        const from = stanza.attrs.from;
        if (!from) {
          return;
        }
        const type = stanza.attrs.type || 'chat';
        const isGroupchat = type === 'groupchat';
        // Check if this is our own message (from our JID) - this is a carbon copy of our sent message
        // The server assigns a stanza-id that clients use for reactions
        const ourJid = config.jid;
        const isOurOwnMessage = from && bareJid(from) === bareJid(ourJid);

        if (isGroupchat) {
          const senderNickFromFrom = from.split('/')[1];
          if (senderNickFromFrom === nickname) {
            log?.debug?.(
              `[${accountId}] XMPP skipping self-message in group (nick=${senderNickFromFrom})`
            );
            return;
          }
        }

        // Ignore delayed history messages so a reconnect cannot replay old turns.
        const delay =
          stanza.getChild('delay', 'urn:xmpp:delay') ?? stanza.getChild('x', 'jabber:x:delay');
        if (delay) {
          log?.debug?.(`[${accountId}] XMPP skipping history message (has delay element)`);
          return;
        }

        // If this is our own message (carbon copy), capture the server-assigned stanza-id
        // This is needed for reactions - users react to the server's ID of our sent messages
        if (isOurOwnMessage) {
          const stanzaIdEl = stanza.getChild('stanza-id', 'urn:xmpp:sid:0');
          const serverMsgId = stanzaIdEl?.attrs?.id;
          const clientMsgId = stanza.attrs.id;

          if (serverMsgId && clientMsgId) {
            // Store mapping: server-side ID -> for later lookup
            // This helps us understand what users are reacting to
            const mapKey = `${accountId}:sent:${serverMsgId}`;
            sentMessageIds.set(mapKey, clientMsgId);
            mappings.set(mapKey, clientMsgId);
            log?.debug?.(
              `[${accountId}] Stored sent message mapping: server=${serverMsgId} -> client=${clientMsgId}`
            );

            // Also store the reverse mapping: client ID -> server ID
            const reverseKey = `${accountId}:${clientMsgId}`;
            sentMessageIds.set(reverseKey, serverMsgId);
            mappings.set(reverseKey, serverMsgId);
            log?.debug?.(
              `[${accountId}] Stored reverse mapping: client=${clientMsgId} -> server=${serverMsgId}`
            );

            // Schedule cleanup after 5 minutes
            const timer = setTimeout(
              () => {
                timers.delete(timer);
                sentMessageIds.delete(mapKey);
                sentMessageIds.delete(reverseKey);
                mappings.delete(mapKey);
                mappings.delete(reverseKey);
              },
              5 * 60 * 1000
            );
            timers.add(timer);
          }

          // Skip processing our own messages - they're just carbon copies
          log?.debug?.(`[${accountId}] XMPP skipping our own message (carbon copy)`);
          return;
        }

        // This baseline does not consume end-to-end encrypted content. Ignore the
        // whole stanza instead of treating an encryption fallback body as a user
        // request.
        if (hasUnsupportedEncryptedPayload(stanza)) {
          log?.debug?.(`[${accountId}] Ignoring unsupported encrypted message`);
          return;
        }

        const body = stanza.getChildText('body');
        log?.debug?.(
          `[${accountId}] XMPP message stanza: body=${body ? `"${body.slice(0, 50)}"` : 'null'}`
        );

        // XEP-0444: Detect incoming reactions (reactions have no body)
        const reactionsEl = stanza.getChild('reactions', 'urn:xmpp:reactions:0');
        if (reactionsEl) {
          const reactedMsgId = reactionsEl.attrs.id;
          const reactionChildren = reactionsEl.getChildren('reaction');
          const emojis = reactionChildren.map((r) => r.text?.() ?? '').filter(Boolean);
          const senderBare = bareJid(from);

          // Determine if this is a groupchat or direct message
          const roomJid = isGroupchat ? bareJid(from) : undefined;
          const senderNick = isGroupchat ? from.split('/')[1] : undefined;

          if (emojis.length > 0) {
            log?.info?.(
              `[${accountId}] XEP-0444 reaction from ${senderBare}: ${emojis.join(', ')} on message ${reactedMsgId}`
            );
          } else {
            log?.info?.(
              `[${accountId}] XEP-0444 reaction removed by ${senderBare} on message ${reactedMsgId}`
            );
          }

          log?.info?.(`[${accountId}] XEP-0444 Routing reaction to OpenClaw...`);

          // Route reaction to OpenClaw so the AI can see and process it
          await handleInboundReaction({
            reactedMessageId: reactedMsgId || '',
            emojis,
            senderBare,
            senderFull: from,
            isGroup: isGroupchat,
            roomJid,
            senderNick,
            cfg,
            accountId,
            config,
            log,
            setStatus,
            runState,
          });

          log?.info?.(`[${accountId}] XEP-0444 Reaction routing completed`);

          // Reactions don't have a body — skip normal message processing
          return;
        }

        // XEP-0066 is retained only as unprivileged text metadata. The URL is
        // surfaced to the model but is never fetched by this plugin.
        const oobElement = stanza.getChild('x', 'jabber:x:oob');
        const oobUrlText = oobElement?.getChildText('url');
        const oobUrl = oobUrlText === '' ? undefined : (oobUrlText ?? undefined);
        const oobDescText = oobElement?.getChildText('desc');
        const oobDesc = oobDescText === '' ? undefined : (oobDescText ?? undefined);
        if (oobUrl) {
          log?.debug?.(
            `[${accountId}] XEP-0066 inbound URL: ${oobUrl}${oobDesc ? ` (${oobDesc})` : ''}`
          );
        }

        if (!body && !oobUrl) {
          return;
        }
        const textBody = body ?? '';

        // History was checked before body parsing.

        const to = stanza.attrs.to;
        const id = stanza.attrs.id || `msg_${Date.now()}`;

        const senderJid = from;
        let roomJid: string | undefined;
        let senderNick: string | undefined;

        if (isGroupchat) {
          roomJid = bareJid(from);
          senderNick = from.split('/')[1];
          // Self-message check already ran above.
        }

        log?.info?.(`[${accountId}] XMPP inbound message: from=${from} type=${type}`);

        // XEP-0461: Parse reply context
        let replyToId: string | undefined;
        let replyToBody: string | undefined;

        const replyElement = stanza.getChild('reply', 'urn:xmpp:reply:0');
        if (replyElement) {
          replyToId = replyElement.attrs.id;
          log?.debug?.(`[${accountId}] XEP-0461 reply to message: ${replyToId}`);

          const fallbackElement = stanza.getChild('fallback', 'urn:xmpp:fallback:0');
          if (fallbackElement && textBody) {
            const lines = textBody.split('\n');
            const quotedLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith('>')) {
                quotedLines.push(line.slice(1).trim());
              } else {
                break;
              }
            }
            if (quotedLines.length > 0) {
              replyToBody = quotedLines.join('\n');
            }
          }
        }

        const message: XmppInboundMessage = {
          id,
          from: senderJid,
          to,
          body: textBody,
          type: type as XmppInboundMessage['type'],
          timestamp: Date.now(),
          isGroup: isGroupchat,
          roomJid,
          senderNick,
          replyToId,
          replyToBody,
          oobUrl,
          oobDesc,
          // XEP-0359: Capture server-assigned stanza-id (preferred for reactions/references)
          // For MUC: MUST use stanza-id with 'by' attribute matching room JID (per XEP-0444)
          // For DMs: Use stanza-id or fall back to stanza's 'id' attribute
          stanzaId: (() => {
            const stanzaIdEl = stanza.getChild('stanza-id', 'urn:xmpp:sid:0');
            if (stanzaIdEl?.attrs?.id) {
              // For MUC, verify the 'by' attribute matches the room JID
              if (isGroupchat && roomJid) {
                const byAttr = stanzaIdEl.attrs.by;
                if (byAttr && bareJid(byAttr) === bareJid(roomJid)) {
                  return stanzaIdEl.attrs.id;
                }
                return undefined;
              }
              return stanzaIdEl.attrs.id;
            }
            return stanza.attrs.id || undefined;
          })(),
          // Raw stanza 'id' attribute (some clients like Gajim use this directly)
          rawStanzaId: stanza.attrs.id,
          // XEP-0359 <origin-id>: the SENDER's stable id. For a 1:1 chat this is the
          // id XEP-0444 says a reaction must target — Conversations indexes its own
          // sent messages by origin-id, not by the recipient-server stanza-id.
          originId: (() => {
            const originId = stanza.getChild('origin-id', 'urn:xmpp:sid:0')?.attrs?.id;
            return originId === '' ? undefined : originId;
          })(),
        };

        await handleInboundMessage(message, cfg, accountId, config, log, setStatus, runState);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log?.error?.(`[${accountId}] Failed to process inbound XMPP stanza: ${error}`);
        setStatus?.({ accountId, lastError: error });
      }
    })().catch((err) => {
      try {
        log?.error?.(
          `[${accountId}] Inbound XMPP stanza task failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } catch {
        // Contain terminal reporting failures without retrying or rethrowing.
      }
    });
  };
  xmpp.on('stanza', onStanza);
  return () => {
    disposed = true;
    xmpp.off('stanza', onStanza);
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    for (const [key, value] of mappings) {
      if (sentMessageIds.get(key) === value) {
        sentMessageIds.delete(key);
      }
    }
    mappings.clear();
  };
}
