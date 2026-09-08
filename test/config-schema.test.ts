import { describe, expect, it } from 'vitest';
import {
  extractJidDomain,
  resolveConnectHost,
  XmppConfigSchema,
  XmppAccountOverrideSchema,
} from '../src/config-schema.js';
import { resolveXmppAccount } from '../src/accounts.js';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';

describe('operational presence configuration', () => {
  it.each(['auto', 'available', 'unavailable'])('accepts %s and safe optional text', (mode) => {
    expect(
      XmppConfigSchema.parse({ presence: { mode, availableText: '', unavailableText: 'Busy' } })
        .presence
    ).toEqual({ mode, availableText: '', unavailableText: 'Busy' });
  });
  it.each([{ mode: 'offline' }, { mode: 'dnd' }, { availableText: 42 }, { status: 'unknown' }])(
    'rejects invalid presence %j',
    (presence) => {
      expect(XmppConfigSchema.safeParse({ presence }).success).toBe(false);
    }
  );
  it('keeps absent overrides absent and defaults auto at derivation time', () => {
    expect(XmppAccountOverrideSchema.parse({})).toEqual({});
    expect(XmppAccountOverrideSchema.parse({ presence: {} })).toEqual({ presence: {} });
    expect(XmppConfigSchema.parse({}).presence).toBeUndefined();
  });
  it.each(['default', 'secondary'])('inherits presence fields individually for %s', (accountId) => {
    const parsed = XmppConfigSchema.parse({
      presence: { mode: 'unavailable', availableText: 'Ready', unavailableText: 'Busy' },
      presenceAllowFrom: ['alice@example.com'],
      accounts: { [accountId]: { jid: 'agent@example.com', presence: { unavailableText: '' } } },
    });
    const config = resolveXmppAccount({
      cfg: { channels: { xmpp: parsed } } as OpenClawConfig,
      accountId,
    }).config;
    expect(config.presence).toEqual({
      mode: 'unavailable',
      availableText: 'Ready',
      unavailableText: '',
    });
    expect(config.presenceAllowFrom).toEqual(['alice@example.com']);
    expect(parsed.accounts?.[accountId]?.presence).toEqual({ unavailableText: '' });
  });
  it('allows an explicit mode and an empty viewer override without widening trust', () => {
    const parsed = XmppConfigSchema.parse({
      presence: { mode: 'unavailable' },
      presenceAllowFrom: ['alice@example.com'],
      accounts: { secondary: { presence: { mode: 'auto' }, presenceAllowFrom: [] } },
    });
    const config = resolveXmppAccount({
      cfg: { channels: { xmpp: parsed } } as OpenClawConfig,
      accountId: 'secondary',
    }).config;
    expect(config.presence).toEqual({ mode: 'auto' });
    expect(config.presenceAllowFrom).toEqual([]);
  });
});

describe('XMPP domain and connection host', () => {
  it('always extracts the logical domain from the JID', () => {
    expect(extractJidDomain('bot@example.com/resource')).toBe('example.com');
  });

  it('uses server only as the physical connection host', () => {
    const config = { jid: 'bot@example.com', server: 'xmpp-edge.example.com' };
    expect(extractJidDomain(config.jid)).toBe('example.com');
    expect(resolveConnectHost(config)).toBe('xmpp-edge.example.com');
  });

  it.each([undefined, '', ' \t '])('falls back to the JID domain for server %j', (server) => {
    expect(resolveConnectHost({ jid: 'bot@example.com', server })).toBe('example.com');
  });

  it('reads and trims a padded server once without evaluating the JID fallback', () => {
    let serverReads = 0;
    const config = {
      get server() {
        serverReads += 1;
        return ' xmpp.example.com ';
      },
      get jid(): string {
        throw new Error('JID fallback must remain lazy');
      },
    };

    expect(resolveConnectHost(config)).toBe('xmpp.example.com');
    expect(serverReads).toBe(1);
  });
});
