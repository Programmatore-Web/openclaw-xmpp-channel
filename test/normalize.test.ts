import { describe, expect, it } from 'vitest';
import { isSenderAllowed, normalizeAllowFrom } from '../src/normalize.js';

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
