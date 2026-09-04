import type { OpenClawConfig, WizardPrompter } from 'openclaw/plugin-sdk/core';
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from 'openclaw/plugin-sdk/core';
import { formatDocsLink, promptAccountId } from 'openclaw/plugin-sdk/setup';
import type { ChannelSetupWizardAdapter } from 'openclaw/plugin-sdk/setup';
import type { DmPolicy } from './types.js';
import { listXmppAccountIds, resolveDefaultXmppAccountId, resolveXmppAccount } from './accounts.js';
import { bareJid } from './config-schema.js';

const channel = 'xmpp' as const;

function resolveXmppAccountConfigLayout(
  cfg: OpenClawConfig,
  accountId?: string
): {
  resolvedAccountId: string;
  current: Record<string, unknown>;
  accounts: Record<string, Record<string, unknown>>;
  useNestedLayout: boolean;
  basePath: string;
} {
  const resolvedAccountId = normalizeAccountId(accountId);
  const current = (cfg.channels?.xmpp ?? {}) as Record<string, unknown>;
  const accounts = (current.accounts ?? {}) as Record<string, Record<string, unknown>>;
  const nestedAccount = accounts[resolvedAccountId];
  const hasNestedDefaultConfig =
    nestedAccount !== undefined &&
    nestedAccount !== null &&
    typeof nestedAccount === 'object' &&
    Object.keys(nestedAccount).length > 0;
  const useNestedLayout = resolvedAccountId !== DEFAULT_ACCOUNT_ID || hasNestedDefaultConfig;

  return {
    resolvedAccountId,
    current,
    accounts,
    useNestedLayout,
    basePath: useNestedLayout ? `channels.xmpp.accounts.${resolvedAccountId}` : 'channels.xmpp',
  };
}

/** Update only the selected XMPP account's existing or canonical config section. */
export function updateXmppAccountConfig(
  cfg: OpenClawConfig,
  accountId: string | undefined,
  updates: Record<string, unknown>
): OpenClawConfig {
  const { resolvedAccountId, current, accounts, useNestedLayout } = resolveXmppAccountConfigLayout(
    cfg,
    accountId
  );

  if (useNestedLayout) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        xmpp: {
          ...current,
          accounts: {
            ...accounts,
            [resolvedAccountId]: {
              ...(accounts[resolvedAccountId] ?? {}),
              ...updates,
            },
          },
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      xmpp: { ...current, ...updates },
    },
  };
}

function resolveXmppDmPolicyConfigKeys(
  cfg: OpenClawConfig,
  accountId?: string
): {
  policyKey: string;
  allowFromKey: string;
} {
  const { basePath } = resolveXmppAccountConfigLayout(cfg, accountId);

  return {
    policyKey: `${basePath}.dmPolicy`,
    allowFromKey: `${basePath}.dmAllowlist`,
  };
}

/**
 * Prompt for XMPP JID and password
 */
async function promptXmppCredentials(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  accountId: string
): Promise<OpenClawConfig> {
  const existing = resolveXmppAccount({ cfg, accountId });

  const jid = await prompter.text({
    message: 'XMPP JID (e.g., bot@example.com)',
    placeholder: 'bot@example.com',
    initialValue: existing?.config?.jid,
    validate: (value) => {
      const raw = String(value ?? '').trim();
      if (!raw) return 'JID is required';
      if (!raw.includes('@')) return 'JID must include @ symbol';
      return undefined;
    },
  });

  const password = await prompter.text({
    message: 'XMPP password',
    sensitive: true,
    validate: (value) => {
      if (String(value ?? '').length === 0) return 'Password is required';
      return undefined;
    },
  });

  const server = await prompter.text({
    message: 'TCP connection host (leave empty to use the JID domain)',
    placeholder: jid.split('@')[1] ?? '',
    initialValue: existing?.config?.server,
  });

  const updates: Record<string, unknown> = {
    jid: jid.trim(),
    password,
  };

  if (server?.trim()) {
    updates.server = server.trim();
  }

  return updateXmppAccountConfig(cfg, accountId, {
    ...updates,
    ...(accountId === DEFAULT_ACCOUNT_ID ? {} : { enabled: true }),
  });
}

/**
 * Prompt for bot owner JIDs (allowFrom)
 */
async function promptXmppOwners(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  accountId: string
): Promise<OpenClawConfig> {
  const existing = resolveXmppAccount({ cfg, accountId }).config.allowFrom;
  const existingLabel = existing?.length ? existing.join(', ') : 'none';

  await prompter.note(
    [
      '`allowFrom` defines the bot owners — JIDs that always have direct chat access',
      'and can manage pairings. At least one owner JID is recommended.',
      '',
      `Current owners: ${existingLabel}`,
    ].join('\n'),
    'Bot owners'
  );

  const allowFromRaw = await prompter.text({
    message: 'Owner JIDs (comma-separated)',
    placeholder: 'user@example.com',
    initialValue: existing?.join(', '),
  });

  const allowFromJids = allowFromRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((jid) => bareJid(jid));

  return updateXmppAccountConfig(cfg, accountId, { allowFrom: allowFromJids });
}

/**
 * Prompt for the additional JIDs admitted by the already-selected allowlist policy.
 */
async function promptXmppDmAllowlist(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  accountId?: string
): Promise<OpenClawConfig> {
  const resolvedAccountId = normalizeAccountId(accountId);
  const existing = resolveXmppAccount({ cfg, accountId: resolvedAccountId }).config.dmAllowlist;
  const allowFromRaw = await prompter.text({
    message: 'Direct-message allowlist JIDs (comma-separated)',
    placeholder: 'user@example.com',
    initialValue: existing?.join(', '),
  });
  const dmAllowlist = allowFromRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((jid) => bareJid(jid));

  return updateXmppAccountConfig(cfg, resolvedAccountId, { dmAllowlist });
}

/**
 * Prompt for group chat rooms to join
 */
async function promptXmppGroups(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  accountId: string
): Promise<OpenClawConfig> {
  const existing = resolveXmppAccount({ cfg, accountId }).config.groups;

  const wantsGroups = await prompter.confirm({
    message: 'Configure group chat rooms?',
    initialValue: (existing?.length ?? 0) > 0,
  });

  if (!wantsGroups) {
    return updateXmppAccountConfig(cfg, accountId, { groups: [] });
  }

  const groupsRaw = await prompter.text({
    message: 'Group room JIDs (comma-separated)',
    placeholder: 'room@conference.example.com',
    initialValue: existing?.join(', '),
  });

  const groups = groupsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return updateXmppAccountConfig(cfg, accountId, { groups });
}

/**
 * XMPP Onboarding Adapter
 */
export const xmppOnboardingAdapter: ChannelSetupWizardAdapter = {
  channel,

  getStatus: async ({ cfg, accountOverrides }) => {
    const overrideId = accountOverrides?.xmpp?.trim();
    const defaultAccountId = resolveDefaultXmppAccountId(cfg);
    const accountId = overrideId ? normalizeAccountId(overrideId) : defaultAccountId;
    const account = resolveXmppAccount({ cfg, accountId });
    const configured = Boolean(account?.config?.jid && account?.config?.password);
    const accountLabel = accountId === DEFAULT_ACCOUNT_ID ? 'default' : accountId;

    return {
      channel,
      configured,
      statusLines: [`XMPP (${accountLabel}): ${configured ? 'configured' : 'not configured'}`],
      selectionHint: configured ? 'configured' : 'not configured',
      quickstartScore: configured ? 3 : 2,
    };
  },

  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const overrideId = accountOverrides?.xmpp?.trim();
    let accountId = overrideId ? normalizeAccountId(overrideId) : resolveDefaultXmppAccountId(cfg);

    if (shouldPromptAccountIds) {
      if (!overrideId) {
        accountId = await promptAccountId({
          cfg,
          prompter,
          label: 'XMPP',
          currentId: accountId,
          listAccountIds: listXmppAccountIds,
          defaultAccountId: resolveDefaultXmppAccountId(cfg),
        });
      }
    }

    let next = cfg;

    // Enable account if using non-default
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      next = updateXmppAccountConfig(next, accountId, { enabled: true });
    }

    // Prompt for credentials
    next = await promptXmppCredentials(next, prompter, accountId);

    // Prompt for bot owner JIDs
    next = await promptXmppOwners(next, prompter, accountId);

    // Prompt for group chat rooms
    next = await promptXmppGroups(next, prompter, accountId);

    await prompter.note(
      [
        'XMPP configuration complete.',
        `Run \`openclaw gateway\` to start the XMPP connection.`,
        `Docs: ${formatDocsLink('/xmpp', 'xmpp')}`,
      ].join('\n'),
      'XMPP setup'
    );

    return { cfg: next, accountId };
  },

  // Guest DM policy is handled by the wizard's dedicated DM-policy pass
  dmPolicy: {
    label: 'XMPP',
    channel,
    policyKey: 'channels.xmpp.dmPolicy',
    allowFromKey: 'channels.xmpp.dmAllowlist',
    resolveConfigKeys: (cfg, accountId) => resolveXmppDmPolicyConfigKeys(cfg, accountId),
    getCurrent: (cfg, accountId): DmPolicy =>
      (resolveXmppAccount({ cfg, accountId: normalizeAccountId(accountId) }).config.dmPolicy as
        DmPolicy | undefined) ?? 'pairing',
    setPolicy: (cfg, policy, accountId) =>
      updateXmppAccountConfig(cfg, accountId, { dmPolicy: policy }),
    promptAllowFrom: async ({ cfg, prompter, accountId }) =>
      promptXmppDmAllowlist(cfg, prompter, accountId),
  },
};
