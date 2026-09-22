import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import {
  createSimpleChannelSecretContract,
  type ResolverContext,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import { describe, expect, it } from 'vitest';
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from '../secret-contract-api.js';
import { hasXmppCredentials, isXmppConfigured, resolveXmppAccount } from '../src/accounts.js';
import { isConfigured, xmppPlugin } from '../src/channel.js';
import { XmppConfigSchema } from '../src/config-schema.js';
import { checkXmppHeartbeatReady } from '../src/heartbeat.js';
import { xmppOnboardingAdapter } from '../src/onboarding.js';
import manifest from '../openclaw.plugin.json';

const ref = { source: 'store', provider: 'default', id: 'XMPP_TEST_PASSWORD' } as const;
const other = { source: 'env', provider: 'default', id: 'XMPP_OTHER_PASSWORD' } as const;
const config = (xmpp: unknown) => ({ channels: { xmpp } }) as OpenClawConfig;
function collect(source: OpenClawConfig, generic = false) {
  const runtime = structuredClone(source);
  const context: ResolverContext = {
    sourceConfig: source,
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
  const collector = generic
    ? createSimpleChannelSecretContract({
        channelKey: 'xmpp',
        label: 'XMPP',
        accountFields: ['password'],
        channelFields: ['password'],
        mode: 'account-inheritance',
      }).collectRuntimeConfigAssignments
    : collectRuntimeConfigAssignments;
  collector({ config: runtime, context });
  return { runtime, context };
}

describe('XMPP SecretInput configuration', () => {
  it.each([
    'legacy-password',
    '  ',
    '${XMPP_TEST_PASSWORD}',
    '$XMPP_TEST_PASSWORD',
    ref,
    other,
    { source: 'file', provider: 'default', id: '/password' },
    { source: 'exec', provider: 'default', id: 'xmpp-password' },
  ])('accepts supported password input %# at every account scope', (password) => {
    for (const xmpp of [
      { jid: 'bot@example.com', password },
      { accounts: { secondary: { jid: 'bot@example.com', password } } },
      { accounts: { default: { jid: 'bot@example.com', password } } },
    ])
      expect(XmppConfigSchema.safeParse(xmpp).success).toBe(true);
  });
  it.each([
    {},
    { source: 'store', id: 'XMPP_TEST_PASSWORD' },
    { ...ref, provider: '' },
    { ...ref, id: '' },
    { ...ref, source: 'unknown' },
    { ...ref, extra: true },
    123,
  ])('rejects malformed input %#', (password) => {
    expect(XmppConfigSchema.safeParse({ password }).success).toBe(false);
    expect(XmppConfigSchema.safeParse({ accounts: { default: { password } } }).success).toBe(false);
  });
  it('keeps manifest password validation identical to the official runtime schema', () => {
    const schema = XmppConfigSchema.toJSONSchema({ target: 'draft-07', io: 'input' }) as any;
    const properties = manifest.channelConfigs.xmpp.schema.properties;
    expect(properties.password).toEqual(schema.properties.password);
    expect(properties.accounts.additionalProperties.properties.password).toEqual(
      schema.properties.accounts.additionalProperties.properties.password
    );
    expect(manifest.channelConfigs.xmpp.schema.additionalProperties).toBe(false);
    expect(properties.accounts.additionalProperties.additionalProperties).toBe(false);
    expect(manifest.channelConfigs.xmpp.uiHints.password.sensitive).toBe(true);
    expect(manifest.channelConfigs.xmpp.uiHints['accounts.*.password'].sensitive).toBe(true);
  });
  it.each(['default', 'secondary'])(
    'inspects unresolved refs for %s without provider access',
    async (accountId) => {
      const cfg = config({ jid: 'bot@example.com', password: ref, accounts: { secondary: {} } });
      const account = resolveXmppAccount({ cfg, accountId });
      expect(isXmppConfigured(cfg)).toBe(true);
      expect(isConfigured(cfg, accountId)).toBe(true);
      expect(await xmppPlugin.status!.probeAccount!({ account, cfg, timeoutMs: 100 })).toEqual({
        ok: true,
        jid: 'bot@example.com',
      });
      expect(xmppPlugin.config.isConfigured!(account, cfg)).toBe(true);
      expect(xmppPlugin.config.describeAccount!(account, cfg).configured).toBe(true);
      expect(
        (await xmppOnboardingAdapter.getStatus({ cfg, accountOverrides: { xmpp: accountId } }))
          .configured
      ).toBe(true);
      expect(await checkXmppHeartbeatReady({ cfg, accountId })).toEqual({
        ok: false,
        reason: 'xmpp-not-connected',
      });
      expect(await xmppPlugin.status!.buildChannelSummary!({ account } as any)).toMatchObject({
        configured: true,
      });
      expect(await xmppPlugin.status!.buildAccountSnapshot!({ account, cfg } as any)).toMatchObject(
        { configured: true }
      );
    }
  );
  it('requires both credentials in account descriptions and preserves opaque whitespace', () => {
    expect(hasXmppCredentials({ jid: 'bot@example.com', password: '  ' })).toBe(true);
    const cfg = config({ jid: 'bot@example.com' });
    expect(xmppPlugin.config.describeAccount!(resolveXmppAccount({ cfg }), cfg).configured).toBe(
      false
    );
  });
});

describe('XMPP account secret contract', () => {
  it('registers root and wildcard targets', () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.pathPattern).sort()).toEqual([
      'channels.xmpp.accounts.*.password',
      'channels.xmpp.password',
    ]);
  });
  it('demonstrates why the generic surface cannot model a root default beside overridden named accounts', () => {
    const cfg = config({
      jid: 'bot@example.com',
      password: ref,
      accounts: { secondary: { password: other } },
    });
    expect(collect(cfg, true).context.assignments.map((a) => a.ownerId)).toEqual([
      'xmpp:secondary',
    ]);
    expect(collect(cfg).context.assignments.map((a) => a.ownerId)).toEqual([
      'xmpp:default',
      'xmpp:secondary',
    ]);
  });
  it.each([
    [{ jid: 'bot@example.com', password: ref }, [['xmpp:default', 'channels.xmpp.password']]],
    [
      { password: ref, accounts: { secondary: { jid: 'bot@example.com' } } },
      [['xmpp:secondary', 'channels.xmpp.password']],
    ],
    [
      { jid: 'bot@example.com', password: ref, accounts: { secondary: {} } },
      [
        ['xmpp:default', 'channels.xmpp.password'],
        ['xmpp:secondary', 'channels.xmpp.password'],
      ],
    ],
    [
      { jid: 'bot@example.com', password: ref, accounts: { default: { password: other } } },
      [['xmpp:default', 'channels.xmpp.accounts.default.password']],
    ],
    [
      { accounts: { default: { jid: 'bot@example.com', password: ref } } },
      [['xmpp:default', 'channels.xmpp.accounts.default.password']],
    ],
    [
      {
        jid: 'bot@example.com',
        password: ref,
        accounts: { secondary: { enabled: false, password: other } },
      },
      [['xmpp:default', 'channels.xmpp.password']],
    ],
    [
      {
        jid: 'bot@example.com',
        enabled: false,
        password: ref,
        accounts: { secondary: { enabled: true } },
      },
      [['xmpp:secondary', 'channels.xmpp.password']],
    ],
    [{ password: ref, accounts: { secondary: { password: other } } }, []],
    [{ jid: 'bot@example.com', enabled: false, password: ref }, []],
    [
      {
        jid: 'bot@example.com',
        password: ref,
        accounts: { default: { password: '' }, secondary: { password: 'override' } },
      },
      [],
    ],
  ])('matches effective consumer paths %#', (xmpp, expected) => {
    const { context } = collect(config(xmpp));
    expect(context.assignments.map((a) => [a.ownerId, a.path])).toEqual(expected);
    for (const assignment of context.assignments) {
      expect(assignment).toMatchObject({
        ownerKind: 'account',
        disposition: 'isolate',
        requiredForGateway: false,
      });
      expect(assignment.ownerContractDigest).toBeTruthy();
    }
  });
  it.each([ref, '${XMPP_TEST_PASSWORD}', '$XMPP_TEST_PASSWORD'])(
    'collects source facts and applies only to the runtime clone %#',
    (password) => {
      const source = config({
        jid: 'bot@example.com',
        password,
        accounts: { secondary: {}, overridden: { password: other } },
      });
      const original = structuredClone(source);
      const { context, runtime } = collect(source);
      expect(context.assignments[0].ref).toEqual({
        ...ref,
        source: typeof password === 'string' ? 'env' : 'store',
      });
      for (const assignment of context.assignments)
        assignment.apply('test-secret-value-DO-NOT-LOG');
      expect(
        resolveXmppAccount({ cfg: runtime }).config.password === 'test-secret-value-DO-NOT-LOG'
      ).toBe(true);
      expect(
        resolveXmppAccount({ cfg: runtime, accountId: 'secondary' }).config.password ===
          'test-secret-value-DO-NOT-LOG'
      ).toBe(true);
      expect(source).toEqual(original);
      expect(JSON.stringify(source).includes('test-secret-value-DO-NOT-LOG')).toBe(false);
    }
  );
});
