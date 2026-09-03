import { vi } from 'vitest';

// Unit tests isolate the channel from OpenClaw runtime initialization. The
// production build still resolves and checks the official 2026.8.2 SDK types.
vi.mock('openclaw/plugin-sdk/core', () => ({
  DEFAULT_ACCOUNT_ID: 'default',
  buildChannelConfigSchema: (schema: unknown, options?: { uiHints?: Record<string, unknown> }) => ({
    schema,
    uiHints: options?.uiHints,
  }),
  emptyPluginConfigSchema: () => ({}),
  formatPairingApproveHint: (channel: string) => `openclaw pairing approve ${channel} <code>`,
  normalizeAccountId: (id: string | null | undefined) => id?.trim() || 'default',
}));

vi.mock('openclaw/plugin-sdk/channel-core', () => ({
  createChannelConfigUiHints: ({ channelLabel }: { channelLabel: string }) => ({
    dmPolicy: { label: `${channelLabel} DM Policy` },
  }),
}));

vi.mock('openclaw/plugin-sdk/setup', () => ({
  formatDocsLink: (path: string, label: string) => `${label} (${path})`,
  promptAccountId: async (params: { currentId?: string; defaultAccountId: string }) =>
    params.currentId ?? params.defaultAccountId,
}));

vi.mock('openclaw/plugin-sdk/channel-policy', () => ({
  buildAccountScopedDmSecurityPolicy: (params: {
    accountId?: string | null;
    fallbackAccountId?: string | null;
    channelKey: string;
    policy?: string | null;
    defaultPolicy?: string;
    allowFrom?: Array<string | number> | null;
    policyPathSuffix?: string;
    allowFromPathSuffix?: string;
    approveChannelId?: string;
    approveHint?: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const accountId = params.accountId ?? params.fallbackAccountId ?? 'default';
    const basePath =
      accountId === 'default'
        ? `channels.${params.channelKey}`
        : `channels.${params.channelKey}.accounts.${accountId}`;
    return {
      policy: params.policy ?? params.defaultPolicy ?? 'pairing',
      allowFrom: params.allowFrom ?? [],
      policyPath: `${basePath}.${params.policyPathSuffix ?? 'dmPolicy'}`,
      allowFromPath: `${basePath}.${params.allowFromPathSuffix ?? 'allowFrom'}`,
      approveHint:
        params.approveHint ??
        `openclaw pairing approve ${params.approveChannelId ?? params.channelKey} <code>`,
      normalizeEntry: params.normalizeEntry,
    };
  },
  resolveToolsBySender: () => undefined,
}));
