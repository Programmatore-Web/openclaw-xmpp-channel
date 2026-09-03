/**
 * MUC (Multi-User Chat) room management
 *
 * Handles explicitly configured room join/leave operations and "gone" tracking.
 */

import { xml } from "@xmpp/client";
import type { client } from "@xmpp/client";
import type { Logger } from "./types.js";
import { normalizeXmppRoomJid } from "./normalize.js";
import {
  goneRooms,
  joinedRooms,
  pendingMucJoins,
  MUC_JOIN_TIMEOUT_MS,
  MUC_LEAVE_WAIT_MS,
} from "./state.js";

// =============================================================================
// MUC JOIN/LEAVE
// =============================================================================

/**
 * Join a MUC room with force rejoin to clear ghost participant state
 */
export async function joinMuc(
  xmpp: ReturnType<typeof client>,
  roomJid: string,
  nick: string,
  log?: Logger,
  accountId?: string,
  forceRejoin = true
): Promise<void> {
  const normalizedRoomJid = normalizeXmppRoomJid(roomJid);

  // Skip rooms that have returned "gone" error
  if (goneRooms.has(normalizedRoomJid)) {
    log?.debug?.(`[XMPP] Skipping gone room: ${roomJid}`);
    return;
  }

  const fullJid = `${roomJid}/${nick}`;

  // Force rejoin: send unavailable presence first to clear any ghost state
  if (forceRejoin) {
    log?.debug?.(`[XMPP] Force leave before join: ${roomJid}`);
    try {
      const leavePresence = xml("presence", { to: fullJid, type: "unavailable" });
      await xmpp.send(leavePresence);
      // Wait for server to process the leave
      await new Promise((r) => setTimeout(r, MUC_LEAVE_WAIT_MS));
    } catch (err) {
      // Ignore errors on leave - room may not have had us joined
      log?.debug?.(
        `[XMPP] Leave presence ignored: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  log?.debug?.(`[XMPP] Joining MUC: ${roomJid}`);

  const presence = xml(
    "presence",
    { to: fullJid },
    xml("x", { xmlns: "http://jabber.org/protocol/muc" })
  );

  try {
    // Create promise to wait for self-presence (status code 110) if we have accountId
    let joinConfirmation: Promise<void> | undefined;
    if (accountId) {
      const pendingKey = `${accountId}:${normalizedRoomJid}`;
      joinConfirmation = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingMucJoins.delete(pendingKey);
          // Don't reject for config rooms - just log and continue
          log?.warn?.(`[XMPP] MUC join confirmation timeout for ${roomJid}, proceeding anyway`);
          resolve();
        }, MUC_JOIN_TIMEOUT_MS);

        pendingMucJoins.set(pendingKey, { resolve, reject, timeout });
      });
    }

    await xmpp.send(presence);
    log?.debug?.(`[XMPP] Sent join presence to ${roomJid}, waiting for confirmation...`);

    // Wait for self-presence confirmation
    if (joinConfirmation) {
      await joinConfirmation;
    }

    // Track as joined
    if (accountId) {
      if (!joinedRooms.has(accountId)) {
        joinedRooms.set(accountId, new Set());
      }
      joinedRooms.get(accountId)!.add(normalizedRoomJid);
    }
    log?.info?.(`[XMPP] Joined MUC: ${roomJid}`);
  } catch (err) {
    log?.error?.(
      `[XMPP] Failed to join MUC ${roomJid}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
