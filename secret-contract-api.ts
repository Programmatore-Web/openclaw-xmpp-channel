import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  type ChannelAccountSurface,
  type ResolverContext,
  type SecretDefaults,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import { listXmppAccountIds, resolveXmppAccount } from './src/accounts.js';

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: 'xmpp',
  channel: ['password'],
  account: ['password'],
});

/** OpenClaw passes its runtime clone here; source config is never modified. */
export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelRecord(params.config, 'xmpp');
  if (!channel) {
    return;
  }
  const cfg = params.config as OpenClawConfig;
  const accounts = channel.accounts as Record<string, Record<string, unknown>> | undefined;
  const surface: ChannelAccountSurface = {
    // XMPP's root default can coexist with named accounts. An empty override
    // represents that consumer, keeping its password assignment at the root.
    hasExplicitAccounts: true,
    channelEnabled: channel.enabled !== false,
    accounts: listXmppAccountIds(cfg).map((accountId) => {
      const resolved = resolveXmppAccount({ cfg, accountId });
      return {
        accountId: resolved.accountId,
        account: accounts?.[resolved.accountId] ?? {},
        enabled: resolved.enabled && Boolean(resolved.config.jid),
      };
    }),
  };
  collectSimpleChannelFieldAssignments({
    channelKey: 'xmpp',
    field: 'password',
    channel,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: 'No enabled XMPP account with a JID inherits this password.',
    accountInactiveReason: 'XMPP account is disabled or has no JID.',
  });
}

export const channelSecrets = { secretTargetRegistryEntries, collectRuntimeConfigAssignments };
