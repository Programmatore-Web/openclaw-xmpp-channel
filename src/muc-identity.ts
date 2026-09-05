/**
 * Minimal XEP-0045 occupant identity tracking.
 *
 * Group allowlists must match a sender's real bare JID, never the mutable
 * room nickname. Servers expose that JID in MUC presence only when the bot is
 * permitted to see it. Missing identity data therefore remains untrusted.
 */

import type { Element } from '@xmpp/client';
import { bareJid } from './config-schema.js';
import { normalizeXmppRoomJid } from './normalize.js';
import type { Logger } from './types.js';

const occupantJids = new Map<string, string>();

function occupantRoomPrefix(accountId: string, roomJid: string): string | undefined {
  const normalizedRoomJid = normalizeXmppRoomJid(roomJid);
  return normalizedRoomJid ? `${accountId}:${normalizedRoomJid}:` : undefined;
}

function occupantKey(accountId: string, roomJid: string, nick: string): string | undefined {
  const roomPrefix = occupantRoomPrefix(accountId, roomJid);
  return roomPrefix ? `${roomPrefix}${nick}` : undefined;
}

/** Record or remove the verified real JID carried by MUC presence. */
export function trackMucOccupantIdentity(stanza: Element, accountId: string, log?: Logger): void {
  if (!stanza.is('presence')) {
    return;
  }

  const from = stanza.attrs.from;
  const slashIndex = from?.indexOf('/') ?? -1;
  if (!from || slashIndex < 1) {
    return;
  }

  const extension = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
  if (!extension) {
    return;
  }

  const roomJid = bareJid(from);
  const nick = from.slice(slashIndex + 1);
  const roomPrefix = occupantRoomPrefix(accountId, roomJid);
  if (!roomPrefix) {
    return;
  }
  const key = `${roomPrefix}${nick}`;

  if (stanza.attrs.type === 'unavailable') {
    occupantJids.delete(key);
    const isSelfPresence = extension
      .getChildren('status')
      .some((status) => status.attrs.code === '110');
    if (isSelfPresence) {
      for (const occupant of occupantJids.keys()) {
        if (occupant.startsWith(roomPrefix)) {
          occupantJids.delete(occupant);
        }
      }
    }
    return;
  }

  // Only ordinary available presence can establish an occupant identity.
  if (stanza.attrs.type) {
    return;
  }

  const realJid = extension.getChild('item')?.attrs?.jid;
  if (!realJid) {
    occupantJids.delete(key);
    return;
  }

  const normalized = bareJid(realJid).toLowerCase();
  occupantJids.set(key, normalized);
  log?.debug?.(`[${accountId}] Verified MUC identity ${roomJid}/${nick} as ${normalized}`);
}

/** Return a previously verified real bare JID for a room occupant. */
export function getMucOccupantRealJid(
  accountId: string,
  roomJid: string,
  nick: string
): string | undefined {
  const key = occupantKey(accountId, roomJid, nick);
  return key ? occupantJids.get(key) : undefined;
}

/** Clear identity observations when an account disconnects or is removed. */
export function clearMucOccupantIdentities(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const key of occupantJids.keys()) {
    if (key.startsWith(prefix)) {
      occupantJids.delete(key);
    }
  }
}
