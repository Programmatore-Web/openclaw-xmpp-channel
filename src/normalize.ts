/**
 * XMPP target normalization utilities
 */

import { isIP, SocketAddress } from "node:net";
import { domainToASCII } from "node:url";
import { bareJid } from "./config-schema.js";

const unsafeDomainDelimiters = new Set([
  "#",
  "%",
  "/",
  ":",
  "<",
  ">",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "|",
]);
const asciiDomainLabelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function isSafeDomainInput(domain: string): boolean {
  for (const character of domain) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x20 || codePoint === 0x7f || unsafeDomainDelimiters.has(character)) {
      return false;
    }
  }
  return true;
}

function isAcceptableAsciiDomain(domain: string): boolean {
  return domain.length > 0 && domain.split(".").every((label) => asciiDomainLabelPattern.test(label));
}

function normalizeBracketedIpv6Literal(domain: string): string | undefined {
  if (!domain.startsWith("[") || !domain.endsWith("]")) return undefined;

  const address = domain.slice(1, -1);
  // Zone identifiers are intentionally unsupported by this local key canonicalizer.
  if (address.includes("%") || isIP(address) !== 6) return undefined;

  const parsed = SocketAddress.parse(`[${address}]:0`);
  if (!parsed || parsed.family !== "ipv6" || !parsed.address) return undefined;

  return `[${parsed.address}]`;
}

/**
 * Check if a string looks like an XMPP JID
 */
export function looksLikeXmppJid(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed) return false;

  // Must have @ symbol
  if (!trimmed.includes("@")) return false;

  // Must have domain after @
  const parts = trimmed.split("@");
  if (parts.length !== 2) return false;
  if (!parts[0] || !parts[1]) return false;

  // Domain should have at least one dot or be localhost
  const domain = parts[1].split("/")[0];
  if (domain !== "localhost" && !domain.includes(".")) return false;

  return true;
}

/**
 * Normalize XMPP target for messaging
 */
export function normalizeXmppTarget(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let target = raw.trim();

  // Strip xmpp: or jabber: prefix
  target = target.replace(/^(xmpp|jabber):/i, "");

  // Validate
  if (!looksLikeXmppJid(target)) return null;

  // Return bare JID
  return bareJid(target);
}

/**
 * Normalize XMPP messaging target (for plugin interface)
 */
export function normalizeXmppMessagingTarget(target: string): string | undefined {
  return normalizeXmppTarget(target) || undefined;
}

/**
 * Canonicalize a MUC room identity for internal state keys.
 * This is intentionally not full RFC 7622/PRECIS validation.
 */
export function normalizeXmppRoomJid(roomJid: string): string | undefined {
  const roomBareJid = bareJid(roomJid);
  if (roomBareJid !== roomJid) return undefined;

  const separatorIndex = roomBareJid.indexOf("@");
  if (
    separatorIndex <= 0 ||
    separatorIndex !== roomBareJid.lastIndexOf("@") ||
    separatorIndex === roomBareJid.length - 1
  ) {
    return undefined;
  }

  const localpart = roomBareJid.slice(0, separatorIndex).toLowerCase().normalize("NFC");
  const unicodeDomain = roomBareJid.slice(separatorIndex + 1).normalize("NFC");
  if (unicodeDomain.includes("[") || unicodeDomain.includes("]")) {
    const ipLiteral = normalizeBracketedIpv6Literal(unicodeDomain);
    return ipLiteral ? `${localpart}@${ipLiteral}` : undefined;
  }

  const hostname = unicodeDomain.endsWith(".") ? unicodeDomain.slice(0, -1) : unicodeDomain;
  if (!isSafeDomainInput(hostname)) return undefined;

  const asciiDomain = domainToASCII(hostname);
  if (!asciiDomain || !isAcceptableAsciiDomain(asciiDomain)) return undefined;

  return `${localpart}@${asciiDomain.toLowerCase()}`;
}

/**
 * Format JID for display
 */
export function formatXmppJid(jid: string): string {
  return bareJid(jid);
}

/**
 * Normalized allowFrom list result
 */
export interface NormalizedAllowFrom {
  entries: string[];
  hasWildcard: boolean;
}

/**
 * Normalize allowFrom list for matching
 */
export function normalizeAllowFrom(list?: string[]): NormalizedAllowFrom {
  if (!list || list.length === 0) {
    return { entries: [], hasWildcard: false };
  }
  const entries = list.map((jid) => bareJid(jid).toLowerCase());
  const hasWildcard = entries.includes("*");
  return { entries, hasWildcard };
}

/**
 * Check if sender is allowed based on normalized allowFrom
 */
export function isSenderAllowed(allowFrom: NormalizedAllowFrom, senderJid: string): boolean {
  if (allowFrom.hasWildcard) return true;
  if (allowFrom.entries.length === 0) return false;
  const normalized = bareJid(senderJid).toLowerCase();
  return allowFrom.entries.includes(normalized);
}
