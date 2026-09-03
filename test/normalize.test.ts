import { describe, expect, it } from 'vitest';
import {
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeXmppRoomJid,
} from '../src/normalize.js';

describe('XMPP allowlist normalization', () => {
  it('treats an undefined allowlist as deny-all', () => {
    const normalized = normalizeAllowFrom(undefined);
    expect(normalized).toEqual({ entries: [], hasWildcard: false });
    expect(isSenderAllowed(normalized, 'user@example.com')).toBe(false);
  });

  it('treats an empty allowlist as deny-all', () => {
    const normalized = normalizeAllowFrom([]);
    expect(normalized).toEqual({ entries: [], hasWildcard: false });
    expect(isSenderAllowed(normalized, 'user@example.com')).toBe(false);
  });

  it('allows any sender only for an explicit wildcard', () => {
    expect(isSenderAllowed(normalizeAllowFrom(['*']), 'user@example.com')).toBe(true);
  });

  it('matches bare JIDs case-insensitively and rejects non-matches', () => {
    const normalized = normalizeAllowFrom(['User@Example.com']);
    expect(isSenderAllowed(normalized, 'user@example.com/resource')).toBe(true);
    expect(isSenderAllowed(normalized, 'other@example.com')).toBe(false);
  });
});

describe('MUC room key normalization', () => {
  it('canonicalizes equivalent Unicode localparts and remains idempotent', () => {
    const decomposed = normalizeXmppRoomJid('Cafe\u0301@conference.example.com');
    const composed = normalizeXmppRoomJid('Café@conference.example.com');

    expect(decomposed).toBe('café@conference.example.com');
    expect(composed).toBe(decomposed);
    expect(normalizeXmppRoomJid(decomposed!)).toBe(decomposed);
  });

  it('canonicalizes casing and remains idempotent', () => {
    const mixedCase = normalizeXmppRoomJid('MixedRoom@Conference.Example.com');
    const lowercase = normalizeXmppRoomJid('mixedroom@conference.example.com');

    expect(mixedCase).toBe(lowercase);
    expect(normalizeXmppRoomJid(mixedCase!)).toBe(mixedCase);
  });

  it('canonicalizes Unicode and ASCII IDN domains and remains idempotent', () => {
    const unicodeDomain = normalizeXmppRoomJid('room@münchen.example');
    const asciiDomain = normalizeXmppRoomJid('room@xn--mnchen-3ya.example');

    expect(unicodeDomain).toBe('room@xn--mnchen-3ya.example');
    expect(asciiDomain).toBe(unicodeDomain);
    expect(normalizeXmppRoomJid(unicodeDomain!)).toBe(unicodeDomain);
  });

  it('fails closed when the domain cannot be converted to ASCII', () => {
    expect(normalizeXmppRoomJid('room@bad domain.example')).toBeUndefined();
    expect(normalizeXmppRoomJid('room@alias@conference.example')).toBeUndefined();
  });
});
