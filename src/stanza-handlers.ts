/**
 * XMPP Stanza Handlers
 *
 * Handles presence stanzas and MUC self-presence/errors.
 */

import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/client';
import type { client } from '@xmpp/client';
import { bareJid } from './config-schema.js';
import type { Logger } from './types.js';
import { goneRooms, pendingMucJoins } from './state.js';
import { trackMucOccupantIdentity } from './muc-identity.js';
import { normalizeXmppRoomJid } from './normalize.js';

/**
 * Setup presence stanza handlers on the XMPP client
 */
export function setupPresenceHandlers(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  log?: Logger,
  handleOperationalPresence?: (type: string, from: string) => Promise<void>
): () => void {
  let disposed = false;
  const onStanza = (stanza: Element): void => {
    if (disposed) {
      return;
    }
    void (async () => {
      try {
        if (!stanza.is('presence')) {
          return;
        }

        const type = stanza.attrs.type;
        const from = stanza.attrs.from;

        if (!from) {
          return;
        }

        const fromBare = bareJid(from);

        // Capture real occupant JIDs when the room exposes them. Group allowlist
        // checks fail closed when this identity cannot be verified.
        trackMucOccupantIdentity(stanza, accountId, log);

        // Check for MUC self-presence (status code 110) - indicates we've joined
        // <presence from="room@conference.example.com/mynick"><x xmlns="...muc#user"><status code="110"/></x></presence>
        const mucUserX = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
        if (mucUserX && !type) {
          const statuses = mucUserX.getChildren('status');
          const isSelfPresence = statuses.some((s) => s.attrs.code === '110');

          if (isSelfPresence) {
            const normalizedRoomJid = normalizeXmppRoomJid(fromBare);
            if (!normalizedRoomJid) {
              log?.warn?.(`[${accountId}] Ignoring MUC self-presence with invalid room JID`);
              return;
            }
            const pendingKey = `${accountId}:${normalizedRoomJid}`;
            const pending = pendingMucJoins.get(pendingKey);
            if (pending) {
              log?.debug?.(`[${accountId}] MUC self-presence received for ${fromBare}`);
              clearTimeout(pending.timeout);
              pending.resolve();
              pendingMucJoins.delete(pendingKey);
            }
          }
        }

        if (['subscribe', 'probe', 'unsubscribe'].includes(type) && handleOperationalPresence) {
          await handleOperationalPresence(type, from);
          return;
        }

        // Handle unsubscribe - acknowledge it
        if (type === 'unsubscribe') {
          log?.info?.(`[${accountId}] XMPP presence unsubscribe from ${fromBare}`);
          const unsubscribed = xml('presence', { to: fromBare, type: 'unsubscribed' });
          await xmpp.send(unsubscribed);
        }

        // Handle presence errors (e.g., MUC join failures)
        if (type === 'error') {
          handlePresenceError(stanza, accountId, from, log);
        }
      } catch (err) {
        log?.warn?.(
          `[${accountId}] Failed to process XMPP presence: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })().catch((err) => {
      try {
        log?.warn?.(
          `[${accountId}] XMPP presence task failed: ${err instanceof Error ? err.message : String(err)}`
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
  };
}

/**
 * Handle presence error stanzas
 */
function handlePresenceError(stanza: Element, accountId: string, from: string, log?: Logger): void {
  const errorEl = stanza.getChild('error');
  const rawErrorType = errorEl?.attrs?.type;
  const errorType = (rawErrorType === '' ? undefined : rawErrorType) ?? 'unknown';
  // Get the first child element that isn't "text" as the error condition
  const conditionName = errorEl?.children?.filter(
    (c): c is Element => typeof c !== 'string' && c.name !== 'text'
  )?.[0]?.name;
  const errorCondition = (conditionName === '' ? undefined : conditionName) ?? 'unknown';
  const errorText = errorEl?.getChildText('text') ?? '';

  const roomJid = bareJid(from);

  // Handle specific error conditions
  if (errorCondition === 'conflict') {
    // Nick conflict should be rare now that we use unique resources per session
    // If it still happens, it's likely a config issue (same nickname on multiple instances)
    log?.error?.(
      `[${accountId}] MUC nick conflict in ${roomJid} - check if another instance is using the same nickname`
    );
  } else if (errorCondition === 'gone') {
    // Room no longer exists
    const normalizedRoomJid = normalizeXmppRoomJid(roomJid);
    if (!normalizedRoomJid) {
      log?.warn?.(`[${accountId}] Ignoring gone error with invalid MUC room JID`);
      return;
    }
    goneRooms.add(normalizedRoomJid);
    log?.warn?.(`[${accountId}] Configured room ${roomJid} no longer exists`);
  } else if (errorCondition === 'recipient-unavailable') {
    // Harmless - server couldn't deliver presence (user offline, no subscription, transient state)
    // Silently ignore - doesn't affect message delivery
  } else {
    // Other errors - log as warning (not error, since presence errors are often transient)
    log?.warn?.(
      `[${accountId}] XMPP presence error from ${from}: type=${errorType} condition=${errorCondition} text="${errorText}"`
    );
  }
}
