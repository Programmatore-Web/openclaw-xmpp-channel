import type { OpenClawConfig, WizardPrompter } from 'openclaw/plugin-sdk/core';
import type { RuntimeEnv } from 'openclaw/plugin-sdk/runtime';
import { describe, expect, it, vi } from 'vitest';
import { resolveXmppAccount } from '../src/accounts.js';
import { updateXmppAccountConfig, xmppOnboardingAdapter } from '../src/onboarding.js';
import type { XmppConfig } from '../src/types.js';

const rootConfig = {
  channels: {
    xmpp: {
      jid: 'bot@example.com',
      password: 'root-password',
      allowFrom: ['root-owner@example.com'],
      groups: ['root@conference.example.com'],
      dmPolicy: 'pairing',
      dmAllowlist: ['root-peer@example.com'],
      accounts: {
        work: {
          jid: 'work-bot@example.com',
          password: 'work-password',
        },
        sibling: {
          jid: 'sibling-bot@example.com',
          password: 'sibling-password',
          allowFrom: ['sibling-owner@example.com'],
          groups: ['sibling@conference.example.com'],
          dmPolicy: 'disabled',
          dmAllowlist: ['sibling-peer@example.com'],
        },
      },
    },
  },
} as unknown as OpenClawConfig;

const nestedDefaultConfig = {
  channels: {
    xmpp: {
      groupPolicy: 'allowlist',
      accounts: {
        default: {
          jid: 'bot@example.com',
          password: 'old-password',
          dmPolicy: 'pairing',
          dmAllowlist: ['old-peer@example.com'],
        },
        sibling: {
          jid: 'sibling-bot@example.com',
          password: 'sibling-password',
          allowFrom: ['sibling-owner@example.com'],
          groups: ['sibling@conference.example.com'],
          dmPolicy: 'disabled',
        },
      },
    },
  },
} as unknown as OpenClawConfig;

function getXmppConfig(cfg: OpenClawConfig): XmppConfig {
  return cfg.channels?.xmpp as XmppConfig;
}

async function configureNamedAccount(): Promise<XmppConfig> {
  const text = vi.fn(async (options: { message: string }) => {
    if (options.message.startsWith('XMPP JID')) return 'work-bot@example.com';
    if (options.message === 'XMPP password') return 'new-work-password';
    if (options.message.startsWith('TCP connection host')) return '';
    if (options.message.startsWith('Owner JIDs')) return 'work-owner@example.com/resource';
    if (options.message.startsWith('Group room JIDs')) return 'work@conference.example.com';
    throw new Error(`Unexpected prompt: ${options.message}`);
  });
  const prompter = {
    text,
    confirm: vi.fn(async () => true),
    select: vi.fn(),
    note: vi.fn(async () => undefined),
  } as unknown as WizardPrompter;

  const result = await xmppOnboardingAdapter.configure({
    cfg: rootConfig,
    runtime: {} as RuntimeEnv,
    prompter,
    accountOverrides: { xmpp: 'work' },
    shouldPromptAccountIds: false,
    forceAllowFrom: false,
  });
  return getXmppConfig(result.cfg);
}

function requireDmPolicyAdapter() {
  const adapter = xmppOnboardingAdapter.dmPolicy;
  if (!adapter) throw new Error('XMPP DM policy adapter is missing');
  return adapter;
}

describe('XMPP onboarding credentials', () => {
  it('uses a sensitive text prompt and preserves password whitespace', async () => {
    const text = vi.fn(async (options: { message: string; sensitive?: boolean }) => {
      if (options.message.startsWith('XMPP JID')) return 'bot@example.com';
      if (options.message === 'XMPP password') return '  whitespace is significant  ';
      if (options.message.startsWith('TCP connection host')) return '';
      if (options.message.startsWith('Owner JIDs')) return 'user@example.com';
      throw new Error(`Unexpected prompt: ${options.message}`);
    });
    const prompter = {
      text,
      confirm: vi.fn(async () => false),
      select: vi.fn(),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const result = await xmppOnboardingAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const config = result.cfg.channels?.xmpp as XmppConfig;

    expect(config.password).toBe('  whitespace is significant  ');
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'XMPP password', sensitive: true })
    );
  });

  it('stores named-account owners without modifying root owners', async () => {
    const config = await configureNamedAccount();

    expect(config.allowFrom).toEqual(['root-owner@example.com']);
    expect(config.accounts?.work?.allowFrom).toEqual(['work-owner@example.com']);
    expect(config.accounts?.sibling?.allowFrom).toEqual(['sibling-owner@example.com']);
  });

  it('stores named-account groups without modifying root groups', async () => {
    const config = await configureNamedAccount();

    expect(config.groups).toEqual(['root@conference.example.com']);
    expect(config.accounts?.work?.groups).toEqual(['work@conference.example.com']);
    expect(config.accounts?.sibling?.groups).toEqual(['sibling@conference.example.com']);
  });
});

describe('XMPP onboarding DM policy account scope', () => {
  it('returns canonical default paths and account-scoped named paths', () => {
    const adapter = requireDmPolicyAdapter();

    expect(adapter.resolveConfigKeys?.(rootConfig, 'default')).toEqual({
      policyKey: 'channels.xmpp.dmPolicy',
      allowFromKey: 'channels.xmpp.dmAllowlist',
    });
    expect(adapter.resolveConfigKeys?.(rootConfig, 'work')).toEqual({
      policyKey: 'channels.xmpp.accounts.work.dmPolicy',
      allowFromKey: 'channels.xmpp.accounts.work.dmAllowlist',
    });
  });

  it('stores a named-account policy without modifying root or sibling policies', () => {
    const adapter = requireDmPolicyAdapter();
    const updated = getXmppConfig(adapter.setPolicy(rootConfig, 'open', 'work'));

    expect(updated.dmPolicy).toBe('pairing');
    expect(updated.accounts?.work?.dmPolicy).toBe('open');
    expect(updated.accounts?.sibling?.dmPolicy).toBe('disabled');
  });

  it('prompts only for named-account allowlist JIDs and preserves other scopes', async () => {
    const adapter = requireDmPolicyAdapter();
    if (!adapter.promptAllowFrom) throw new Error('XMPP DM allowlist prompt is missing');
    const text = vi.fn(async () => 'user@example.com/resource, second@example.com/mobile');
    const select = vi.fn();
    const prompter = {
      text,
      select,
      confirm: vi.fn(),
      note: vi.fn(),
    } as unknown as WizardPrompter;

    const result = await adapter.promptAllowFrom({
      cfg: rootConfig,
      prompter,
      accountId: 'work',
    });
    const updated = getXmppConfig(result);

    expect(text).toHaveBeenCalledOnce();
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Direct-message allowlist JIDs (comma-separated)',
        placeholder: 'user@example.com',
      })
    );
    expect(select).not.toHaveBeenCalled();
    expect(updated.dmAllowlist).toEqual(['root-peer@example.com']);
    expect(updated.accounts?.work?.dmAllowlist).toEqual([
      'user@example.com',
      'second@example.com',
    ]);
    expect(updated.accounts?.sibling?.dmAllowlist).toEqual(['sibling-peer@example.com']);
  });

  it('stores an explicit empty named-account allowlist instead of reviving inheritance', async () => {
    const adapter = requireDmPolicyAdapter();
    if (!adapter.promptAllowFrom) throw new Error('XMPP DM allowlist prompt is missing');
    const prompter = {
      text: vi.fn(async () => '   '),
      select: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
    } as unknown as WizardPrompter;

    const result = await adapter.promptAllowFrom({
      cfg: rootConfig,
      prompter,
      accountId: 'work',
    });

    expect(getXmppConfig(result).accounts?.work?.dmAllowlist).toEqual([]);
  });
});

describe('XMPP default-account layout compatibility', () => {
  it('keeps root-only default-account updates in the canonical root layout', () => {
    const updated = getXmppConfig(
      updateXmppAccountConfig(rootConfig, 'default', {
        allowFrom: ['new-owner@example.com'],
      })
    );

    expect(updated.allowFrom).toEqual(['new-owner@example.com']);
    expect(updated.accounts?.default).toBeUndefined();
    expect(updated.accounts?.sibling?.allowFrom).toEqual(['sibling-owner@example.com']);
  });

  it('keeps default-account policy and allowlist updates in an existing nested layout', async () => {
    const adapter = requireDmPolicyAdapter();
    if (!adapter.promptAllowFrom) throw new Error('XMPP DM allowlist prompt is missing');
    const bothLayouts = {
      channels: {
        xmpp: {
          dmPolicy: 'disabled',
          dmAllowlist: ['root-peer@example.com'],
          accounts: getXmppConfig(nestedDefaultConfig).accounts,
        },
      },
    } as unknown as OpenClawConfig;
    const withPolicy = adapter.setPolicy(bothLayouts, 'allowlist', 'default');
    const prompter = {
      text: vi.fn(async () => 'user@example.com/resource'),
      select: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
    } as unknown as WizardPrompter;
    const result = await adapter.promptAllowFrom({
      cfg: withPolicy,
      prompter,
      accountId: 'default',
    });
    const updated = getXmppConfig(result);

    expect(updated.dmPolicy).toBe('disabled');
    expect(updated.dmAllowlist).toEqual(['root-peer@example.com']);
    expect(updated.accounts?.default?.dmPolicy).toBe('allowlist');
    expect(updated.accounts?.default?.dmAllowlist).toEqual(['user@example.com']);
    expect(updated.accounts?.sibling?.dmPolicy).toBe('disabled');
  });

  it('returns nested DM policy paths for an existing accounts.default layout', () => {
    const keys = requireDmPolicyAdapter().resolveConfigKeys?.(nestedDefaultConfig, 'default');

    expect(keys).toEqual({
      policyKey: 'channels.xmpp.accounts.default.dmPolicy',
      allowFromKey: 'channels.xmpp.accounts.default.dmAllowlist',
    });
  });

  it('makes nested default credentials, owners, and groups effective', async () => {
    const text = vi.fn(async (options: { message: string }) => {
      if (options.message.startsWith('XMPP JID')) return 'updated-bot@example.com';
      if (options.message === 'XMPP password') return '  updated password  ';
      if (options.message.startsWith('TCP connection host')) return '';
      if (options.message.startsWith('Owner JIDs')) return 'updated-owner@example.com/resource';
      if (options.message.startsWith('Group room JIDs')) {
        return 'updated-room@conference.example.com';
      }
      throw new Error(`Unexpected prompt: ${options.message}`);
    });
    const prompter = {
      text,
      confirm: vi.fn(async () => true),
      select: vi.fn(),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const result = await xmppOnboardingAdapter.configure({
      cfg: nestedDefaultConfig,
      runtime: {} as RuntimeEnv,
      prompter,
      accountOverrides: { xmpp: 'default' },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const root = getXmppConfig(result.cfg);
    const resolved = resolveXmppAccount({ cfg: result.cfg, accountId: 'default' }).config;

    expect(root.jid).toBeUndefined();
    expect(root.password).toBeUndefined();
    expect(root.allowFrom).toBeUndefined();
    expect(root.groups).toBeUndefined();
    expect(resolved.jid).toBe('updated-bot@example.com');
    expect(resolved.password).toBe('  updated password  ');
    expect(resolved.allowFrom).toEqual(['updated-owner@example.com']);
    expect(resolved.groups).toEqual(['updated-room@conference.example.com']);
  });

  it('leaves named siblings unchanged when updating the nested default account', () => {
    const siblingBefore = getXmppConfig(nestedDefaultConfig).accounts?.sibling;
    const updated = getXmppConfig(
      updateXmppAccountConfig(nestedDefaultConfig, 'default', {
        allowFrom: ['updated-owner@example.com'],
      })
    );

    expect(updated.accounts?.sibling).toEqual(siblingBefore);
  });
});
