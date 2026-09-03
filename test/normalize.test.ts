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

  it.each([
    ['backslash', 'room@foo\\bar.example'],
    ['slash', 'room@foo/bar.example'],
    ['question mark', 'room@foo?bar.example'],
    ['hash', 'room@foo#bar.example'],
    ['colon', 'room@foo:bar.example'],
    ['ASCII space', 'room@foo bar.example'],
    ['tab', 'room@foo\tbar.example'],
    ['newline', 'room@foo\nbar.example'],
    ['carriage return', 'room@foo\rbar.example'],
    ['percent encoding', 'room@foo%2Ebar.example'],
    ['brackets', 'room@[foo].example'],
    ['semicolon', 'room@foo;bar.example'],
    ['double quote', 'room@foo"bar.example'],
    ['underscore', 'room@foo_bar.example'],
  ])('rejects %s instead of accepting a partially parsed domain', (_label, roomJid) => {
    expect(normalizeXmppRoomJid(roomJid)).toBeUndefined();
  });

  it('does not collapse a partially parsed invalid domain onto a valid state key', () => {
    const invalid = normalizeXmppRoomJid('room@foo\\bar.example');
    const valid = normalizeXmppRoomJid('room@foo');

    expect(invalid).toBeUndefined();
    expect(valid).toBe('room@foo');
    expect(invalid).not.toBe(valid);
  });

  it('removes one final root dot, rejects empty internal labels, and remains idempotent', () => {
    const withoutRootDot = normalizeXmppRoomJid('room@conference.example.com');
    const withRootDot = normalizeXmppRoomJid('room@conference.example.com.');

    expect(withRootDot).toBe(withoutRootDot);
    expect(withRootDot).toBe('room@conference.example.com');
    expect(normalizeXmppRoomJid(withRootDot!)).toBe(withRootDot);
    expect(normalizeXmppRoomJid('room@foo..example.com')).toBeUndefined();
    expect(normalizeXmppRoomJid('room@conference.example.com..')).toBeUndefined();
  });

  it('accepts IPv4 and canonicalizes equivalent bracketed IPv6 domainparts', () => {
    expect(normalizeXmppRoomJid('room@127.0.0.1')).toBe('room@127.0.0.1');

    const loopback = normalizeXmppRoomJid('room@[::1]');
    const expandedLoopback = normalizeXmppRoomJid('room@[0:0:0:0:0:0:0:1]');
    expect(loopback).toBe('room@[::1]');
    expect(expandedLoopback).toBe(loopback);

    const documentation = normalizeXmppRoomJid('room@[2001:0db8:0:0:0:0:0:1]');
    const compressedDocumentation = normalizeXmppRoomJid('room@[2001:db8::1]');
    expect(documentation).toBe('room@[2001:db8::1]');
    expect(compressedDocumentation).toBe(documentation);

    expect(normalizeXmppRoomJid(loopback!)).toBe(loopback);
    expect(normalizeXmppRoomJid(documentation!)).toBe(documentation);
  });

  it.each([
    ['missing closing bracket', 'room@[::1'],
    ['missing opening bracket', 'room@::1]'],
    ['non-IP contents', 'room@[not-an-ip]'],
    ['bracketed IPv4', 'room@[127.0.0.1]'],
    ['IPv6 zone identifier', 'room@[fe80::1%eth0]'],
  ])('rejects malformed or unsupported IP literals: %s', (_label, roomJid) => {
    expect(normalizeXmppRoomJid(roomJid)).toBeUndefined();
  });
});
