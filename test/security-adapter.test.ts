import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { describe, expect, it } from 'vitest';
import { xmppPlugin } from '../src/channel.js';
import type { ResolvedXmppAccount } from '../src/types.js';

function resolvePolicy(account: ResolvedXmppAccount, cfg: OpenClawConfig = {} as OpenClawConfig) {
  const resolver = xmppPlugin.security?.resolveDmPolicy;
  if (!resolver) throw new Error('XMPP DM policy resolver is missing');
  return resolver({ cfg, accountId: account.accountId, account });
}

function account(dmPolicy: 'disabled' | 'open' | 'pairing' | 'allowlist'): ResolvedXmppAccount {
  return {
    accountId: 'security-adapter-test',
    enabled: true,
    config: {
      jid: 'bot@example.com',
      password: 'password',
      dmPolicy,
      allowFrom: ['owner@example.com'],
      dmAllowlist: ['user@example.com'],
    },
  };
}

describe('OpenClaw security adapter DM policy reporting', () => {
  it('reports owner and DM allowlist entries only for allowlist policy', () => {
    expect(resolvePolicy(account('allowlist'))?.allowFrom).toEqual([
      'owner@example.com',
      'user@example.com',
    ]);
  });

  it.each(['pairing', 'disabled', 'open'] as const)(
    'does not report dmAllowlist as statically authorized for %s policy',
    (policy) => {
      expect(resolvePolicy(account(policy))?.allowFrom).toEqual(['owner@example.com']);
    }
  );

  it('reports named-account policy and allowlist paths for an explicit override', () => {
    const namedAccount = account('allowlist');
    const cfg = {
      channels: {
        xmpp: {
          dmPolicy: 'pairing',
          allowFrom: ['root-owner@example.com'],
          accounts: {
            'security-adapter-test': namedAccount.config,
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePolicy(namedAccount, cfg)).toMatchObject({
      policyPath: 'channels.xmpp.accounts.security-adapter-test.dmPolicy',
      allowFromPath: 'channels.xmpp.accounts.security-adapter-test.dmAllowlist',
      allowFrom: ['owner@example.com', 'user@example.com'],
    });
  });
});
