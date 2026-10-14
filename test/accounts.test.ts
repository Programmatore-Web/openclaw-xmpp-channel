import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { describe, expect, it } from 'vitest';
import {
  listEnabledXmppAccounts,
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
} from '../src/accounts.js';

const config = (xmpp: unknown) => ({ channels: { xmpp } }) as OpenClawConfig;
const account = (id: string) => ({ jid: `${id}@example.com`, password: `${id}-fixture` });

describe('explicit XMPP default account', () => {
  for (const ids of [
    ['oria', 'main'],
    ['main', 'oria'],
  ]) {
    it.each(['oria', 'main'])(`selects %s with order ${ids.join(', ')}`, (defaultAccount) => {
      const cfg = config({
        defaultAccount,
        accounts: Object.fromEntries(ids.map((id) => [id, account(id)])),
      });
      const before = structuredClone(cfg);
      expect(resolveDefaultXmppAccountId(cfg)).toBe(defaultAccount);
      expect(resolveXmppAccount({ cfg }).config.jid).toBe(`${defaultAccount}@example.com`);
      expect(resolveXmppAccount({ cfg, accountId: null }).accountId).toBe(defaultAccount);
      expect(listXmppAccountIds(cfg)).toEqual(ids);
      expect(listEnabledXmppAccounts(cfg).map((a) => a.accountId)).toEqual(ids);
      expect(cfg).toEqual(before);
    });
  }

  it.each(['main', 'missing', ''])(
    'keeps explicit operation IDs ahead of preference %j',
    (defaultAccount) => {
      const cfg = config({
        defaultAccount,
        accounts: { oria: account('oria'), main: account('main'), default: account('default') },
      });
      expect(resolveXmppAccount({ cfg, accountId: 'oria' }).accountId).toBe('oria');
      expect(resolveXmppAccount({ cfg, accountId: 'default' }).config.jid).toBe(
        'default@example.com'
      );
    }
  );

  it('overrides accounts.default without changing its root/nested merge', () => {
    const cfg = config({
      ...account('root'),
      defaultAccount: 'main',
      allowFrom: ['owner@example.com'],
      accounts: { default: account('nested'), main: account('main') },
    });
    expect(resolveDefaultXmppAccountId(cfg)).toBe('main');
    expect(resolveXmppAccount({ cfg, accountId: 'default' }).config).toMatchObject({
      jid: 'nested@example.com',
      allowFrom: ['owner@example.com'],
    });
  });

  it.each([
    { defaultAccount: 'default', ...account('root') },
    { defaultAccount: 'default', accounts: { default: account('nested') } },
    { defaultAccount: 'main', accounts: { main: account('main') } },
  ])('supports a single existing default in %j', (root) => {
    expect(resolveDefaultXmppAccountId(config(root))).toBe(root.defaultAccount);
  });

  it.each([{}, { enabled: false }, { jid: 'main@example.com' }])(
    'selects an unavailable account without failover: %j',
    (main) => {
      const cfg = config({ defaultAccount: 'main', accounts: { oria: account('oria'), main } });
      expect(resolveDefaultXmppAccountId(cfg)).toBe('main');
      expect(resolveXmppAccount({ cfg }).accountId).toBe('main');
    }
  );

  it('selects an enumerated root default even when disabled and missing its password', () => {
    const cfg = config({
      defaultAccount: 'default',
      jid: 'root@example.com',
      enabled: false,
      accounts: { main: account('main') },
    });
    expect(listXmppAccountIds(cfg)).toEqual(['default', 'main']);
    expect(resolveDefaultXmppAccountId(cfg)).toBe('default');
    expect(resolveXmppAccount({ cfg })).toMatchObject({
      accountId: 'default',
      enabled: false,
      config: { jid: 'root@example.com' },
    });
    expect(resolveXmppAccount({ cfg }).config.password).toBeUndefined();
  });

  it('selects an incomplete accounts.default instead of a usable sibling', () => {
    const cfg = config({
      defaultAccount: 'default',
      accounts: { main: account('main'), default: {} },
    });
    expect(listXmppAccountIds(cfg)).toEqual(['main', 'default']);
    expect(resolveDefaultXmppAccountId(cfg)).toBe('default');
    const selected = resolveXmppAccount({ cfg });
    expect(selected.accountId).toBe('default');
    expect(selected.config.jid).toBeUndefined();
    expect(selected.config.password).toBeUndefined();
  });

  it.each([{}, { main: account('main') }])(
    'rejects a non-enumerated root default without creating an account or falling back: %j',
    (accounts) => {
      const cfg = config({ defaultAccount: 'default', enabled: false, accounts });
      const before = structuredClone(cfg);
      expect(listXmppAccountIds(cfg)).toEqual(Object.keys(accounts));
      expect(() => resolveDefaultXmppAccountId(cfg)).toThrow('unconfigured account ID: default');
      expect(() => resolveXmppAccount({ cfg })).toThrow('unconfigured account ID: default');
      expect(cfg).toEqual(before);
      expect(listXmppAccountIds(cfg)).not.toContain('default');
    }
  );

  it.each([
    '',
    ' ',
    ' main',
    'main\n',
    'MAIN',
    'a/b',
    '__proto__',
    'constructor',
    'prototype',
    'a'.repeat(65),
    null,
    0,
    {},
    [],
  ])('rejects malformed preference %j', (defaultAccount) => {
    expect(() =>
      resolveDefaultXmppAccountId(
        config({ defaultAccount, accounts: { main: account('main'), default: account('default') } })
      )
    ).toThrow('channels.xmpp.defaultAccount');
  });

  it.each([
    {},
    { accounts: { main: account('main') } },
    { ...account('root'), accounts: { main: account('main') } },
  ])('never falls back from a missing preference: %j', (root) => {
    expect(() =>
      resolveDefaultXmppAccountId(config({ ...root, defaultAccount: 'missing' }))
    ).toThrow('unconfigured account ID');
  });
});

describe('legacy XMPP account selection', () => {
  it.each([
    [{}, 'default', []],
    [{ ...account('root') }, 'default', ['default']],
    [{ accounts: { oria: account('oria') } }, 'oria', ['oria']],
    [{ accounts: { oria: {}, main: account('main') } }, 'oria', ['oria', 'main']],
    [{ accounts: { main: { enabled: false }, oria: account('oria') } }, 'main', ['main', 'oria']],
    [{ accounts: { oria: {}, default: account('nested') } }, 'default', ['oria', 'default']],
    [{ ...account('root'), accounts: { main: account('main') } }, 'default', ['default', 'main']],
  ])('preserves selection for %j', (root, expected, ids) => {
    const cfg = config(root);
    expect(resolveDefaultXmppAccountId(cfg)).toBe(expected);
    expect(listXmppAccountIds(cfg)).toEqual(ids);
  });
});
