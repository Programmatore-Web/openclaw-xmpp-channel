/**
 * XMPP Connection Monitor
 *
 * Main entry point for XMPP connection management.
 * Handles connection lifecycle, message routing, and event dispatch.
 */

import { client, xml } from '@xmpp/client';
import type { Element } from '@xmpp/client';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { XmppConfig, GatewayStartContext, XmppInboundMessage, Logger } from './types.js';
import { resolveConnectHost, extractJidDomain, extractUsername, bareJid } from './config-schema.js';
import { selectPasswordSaslMechanism } from './sasl.js';

// Import from split modules
import { activeClients, reconnectStates, sentMessageIds } from './state.js';
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
  const { account, cfg, abortSignal, log, setStatus } = ctx;
  const accountId = ctx.accountId ?? account.accountId ?? 'default';
  const config = account.config;

  log?.debug?.(`[${accountId}] Gateway context: hasSetStatus=${!!setStatus}`);

  if (!config.jid || !config.password) {
    throw new Error('XMPP jid and password are required');
  }

  if (!reconnectStates.has(accountId)) {
    initReconnectState(accountId);
  }

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
      lastStartAt: Date.now(),
      lastError: null,
    });
  } else {
    log?.error?.(`[${accountId}] XMPP ERROR: setStatus function not provided by OpenClaw!`);
  }

  const xmpp = client({
    service: `xmpp://${connectHost}:${config.port ?? 5222}`,
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

  // Store client for outbound messaging
  activeClients.set(accountId, xmpp);

  // XEP-0198 Stream Management event handlers
  const streamManagement = (
    xmpp as unknown as {
      streamManagement?: {
        on?: (event: string, handler: (stanza?: Element) => void) => void;
      };
    }
  ).streamManagement;

  if (streamManagement && typeof streamManagement.on === 'function') {
    streamManagement.on('resumed', () => {
      log?.info?.(`[${accountId}] XEP-0198 Stream Management: session resumed`);
      setStatus?.({ accountId, connected: true, lastConnectedAt: Date.now() });
    });

    streamManagement.on('fail', (stanza) => {
      log?.warn?.(
        `[${accountId}] XEP-0198 Stream Management: stanza failed to send: ${stanza?.toString()?.slice(0, 100)}`
      );
    });

    streamManagement.on('ack', () => {
      log?.debug?.(`[${accountId}] XEP-0198 Stream Management: stanza acknowledged`);
    });
  }

  // Setup message stanza handler
  setupMessageHandler(xmpp, accountId, nickname, cfg, config, log, setStatus);

  // Setup presence handlers (fail-closed subscriptions, MUC identity/presence)
  setupPresenceHandlers(xmpp, accountId, log);

  // Connection events
  xmpp.on('online', async (address) => {
    if (activeClients.get(accountId) !== xmpp) {
      return;
    }
    log?.info?.(`[${accountId}] XMPP online as ${address.toString()}`);

    // Start XEP-0199 keepalive pings
    startKeepalive(xmpp, accountId, jidDomain, log);

    // Enable XEP-0280 Message Carbons
    try {
      const enableCarbons = xml(
        'iq',
        { type: 'set', id: `carbons-${Date.now()}` },
        xml('enable', { xmlns: 'urn:xmpp:carbons:2' })
      );
      await xmpp.send(enableCarbons);
      log?.debug?.(`[${accountId}] XEP-0280 Message Carbons enabled`);
    } catch (err) {
      log?.warn?.(
        `[${accountId}] Failed to enable carbons: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Send initial presence
    const initialPresence = xml(
      'presence',
      {},
      xml('status', {}, 'OpenClaw Bot Online'),
      xml('priority', {}, '1')
    );
    try {
      await xmpp.send(initialPresence);
      log?.debug?.(`[${accountId}] XMPP initial presence sent`);
    } catch (err) {
      log?.error?.(
        `[${accountId}] XMPP failed to send initial presence: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Mark as connected
    setStatus?.({
      accountId,
      running: true,
      connected: true,
      lastConnectedAt: Date.now(),
      lastError: null,
    });

    // Join only rooms explicitly declared in this account's configuration.
    // This whole block runs inside the async `online` event handler, so any
    // throw here (e.g. the stream dropping mid-join and rejecting a send with
    // a StreamError) escapes as an unhandled rejection. Keep it contained: a
    // failed join is non-fatal — the reconnect path will retry — and must
    // never bubble out of the handler.
    try {
      if (config.groups && config.groups.length > 0) {
        log?.info?.(`[${accountId}] Joining ${config.groups.length} group rooms...`);
        for (const room of config.groups) {
          await joinMuc(xmpp, room, nickname, log, accountId, true);
        }
      } else {
        log?.debug?.(`[${accountId}] No group rooms configured`);
      }
    } catch (err) {
      log?.warn?.(
        `[${accountId}] Room (re)join interrupted (non-fatal, will retry on reconnect): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  xmpp.on('offline', () => {
    if (activeClients.get(accountId) !== xmpp) {
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
      scheduleReconnect(accountId, ctx, log);
    }
  });

  xmpp.on('error', (err) => {
    if (activeClients.get(accountId) !== xmpp) {
      return;
    }
    log?.error?.(`[${accountId}] XMPP error: ${err.message}`);
    setStatus?.({ accountId, lastError: err.message });
  });

  // Start connection
  try {
    await xmpp.start();
    clearReconnectState(accountId);
    initReconnectState(accountId);
  } catch (err) {
    log?.error?.(
      `[${accountId}] XMPP connection failed: ${err instanceof Error ? err.message : String(err)}`
    );
    setStatus?.({ accountId, lastError: err instanceof Error ? err.message : String(err) });
    scheduleReconnect(accountId, ctx, log);
  }

  // Return a promise that stays pending until the connection is stopped
  return new Promise<void>((resolve) => {
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      const isCurrent = activeClients.get(accountId) === xmpp;
      if (isCurrent) {
        abortReconnect(accountId);
        clearReconnectState(accountId);
        log?.info?.(`[${accountId}] Stopping XMPP connection...`);
        stopKeepalive(accountId);
        clearMucOccupantIdentities(accountId);
      }

      void xmpp.stop().catch((err) => {
        log?.warn?.(
          `[${accountId}] XMPP stop failed during cleanup: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      if (isCurrent) {
        activeClients.delete(accountId);
        setStatus?.({
          accountId,
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
      }

      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
    } else {
      abortSignal?.addEventListener('abort', cleanup);
    }
  });
}

// Register this function for reconnect module (avoids circular dependency)
registerStartXmppConnection(startXmppConnection);

// =============================================================================
// MESSAGE STANZA HANDLER
// =============================================================================

/** Detect unsupported application-layer encrypted message payloads. */
export function hasUnsupportedEncryptedPayload(stanza: Element): boolean {
  return Boolean(stanza.getChild('encryption', 'urn:xmpp:eme:0') || stanza.getChild('encrypted'));
}

export function setupMessageHandler(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  nickname: string,
  cfg: OpenClawConfig,
  config: XmppConfig,
  log?: Logger,
  setStatus?: GatewayStartContext['setStatus']
): void {
  xmpp.on('stanza', async (stanza) => {
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
        stanza.getChild('delay', 'urn:xmpp:delay') || stanza.getChild('x', 'jabber:x:delay');
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
          log?.debug?.(
            `[${accountId}] Stored sent message mapping: server=${serverMsgId} -> client=${clientMsgId}`
          );

          // Also store the reverse mapping: client ID -> server ID
          const reverseKey = `${accountId}:${clientMsgId}`;
          sentMessageIds.set(reverseKey, serverMsgId);
          log?.debug?.(
            `[${accountId}] Stored reverse mapping: client=${clientMsgId} -> server=${serverMsgId}`
          );

          // Schedule cleanup after 5 minutes
          setTimeout(
            () => {
              sentMessageIds.delete(mapKey);
              sentMessageIds.delete(reverseKey);
            },
            5 * 60 * 1000
          );
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
        });

        log?.info?.(`[${accountId}] XEP-0444 Reaction routing completed`);

        // Reactions don't have a body — skip normal message processing
        return;
      }

      // XEP-0066 is retained only as unprivileged text metadata. The URL is
      // surfaced to the model but is never fetched by this plugin.
      const oobElement = stanza.getChild('x', 'jabber:x:oob');
      const oobUrl = oobElement?.getChildText('url') || undefined;
      const oobDesc = oobElement?.getChildText('desc') || undefined;
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
        originId: stanza.getChild('origin-id', 'urn:xmpp:sid:0')?.attrs?.id || undefined,
      };

      await handleInboundMessage(message, cfg, accountId, config, log, setStatus);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log?.error?.(`[${accountId}] Failed to process inbound XMPP stanza: ${error}`);
      setStatus?.({ accountId, lastError: error });
    }
  });
}
