import { describe, expect, it } from 'vitest';
import manifest from '../openclaw.plugin.json';
import packageJson from '../package.json';
import {
  XmppAccountSchema,
  XmppAccountOverrideSchema,
  XmppConfigSchema,
  xmppChannelConfigSchema,
} from '../src/config-schema.js';
import { xmppConfigUiHints } from '../src/config-ui-hints.js';
import { resolveXmppAccount } from '../src/accounts.js';

type JsonSchema = {
  type?: string;
  default?: unknown;
  enum?: unknown[];
  sensitive?: unknown;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

const channelConfig = manifest.channelConfigs.xmpp;
const channelSchema = channelConfig.schema as JsonSchema;
const rootProperties = channelSchema.properties ?? {};
const accountSchema = rootProperties.accounts?.additionalProperties as JsonSchema;
const accountProperties = accountSchema.properties ?? {};
const uiHints = channelConfig.uiHints;
const runtimeRootProperties = (
  XmppAccountSchema.toJSONSchema({ target: 'draft-07', io: 'input' }) as JsonSchema
).properties ?? {};
const runtimeOverrideProperties = (
  XmppAccountOverrideSchema.toJSONSchema({ target: 'draft-07', io: 'input' }) as JsonSchema
).properties ?? {};

const accountFieldNames = [
  'enabled',
  'name',
  'jid',
  'password',
  'server',
  'port',
  'resource',
  'nickname',
  'dmPolicy',
  'allowFrom',
  'dmAllowlist',
  'groupPolicy',
  'groupAllowFrom',
  'groups',
  'actions',
  'sendReadReceipts',
  'heartbeatVisibility',
  'groupSettings',
] as const;

describe('OpenClaw Control UI channel manifest', () => {
  it('keeps plugin config empty and declares the XMPP channel cold-path schema', () => {
    expect(manifest.configSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    });
    expect(channelConfig.label).toBe('XMPP');
    expect(manifest.channels).toEqual(['xmpp']);
    expect(packageJson.openclaw.channel.id).toBe('xmpp');
  });

  it('exposes the complete root account shape with fail-closed defaults', () => {
    expect(Object.keys(rootProperties)).toEqual(expect.arrayContaining([...accountFieldNames]));
    expect(rootProperties.enabled?.default).toBe(true);
    expect(rootProperties.port?.default).toBe(5222);
    expect(rootProperties.dmPolicy?.default).toBe('pairing');
    expect(rootProperties.groupPolicy?.default).toBe('allowlist');
    expect(rootProperties.sendReadReceipts?.default).toBe(true);
    expect(runtimeRootProperties.enabled?.default).toBe(true);
    expect(runtimeRootProperties.port?.default).toBe(5222);
    expect(runtimeRootProperties.dmPolicy?.default).toBe('pairing');
    expect(runtimeRootProperties.groupPolicy?.default).toBe('allowlist');
    expect(runtimeRootProperties.sendReadReceipts?.default).toBe(true);
  });

  it('models named accounts as a dynamic map with the complete account shape', () => {
    expect(rootProperties.accounts?.type).toBe('object');
    expect(accountSchema.type).toBe('object');
    expect(Object.keys(accountProperties)).toEqual(expect.arrayContaining([...accountFieldNames]));
    expect(accountProperties.enabled?.type).toBe('boolean');
    expect(accountProperties.jid?.type).toBe('string');
    expect(accountProperties.password?.type).toBe('string');
    expect(accountProperties.allowFrom?.type).toBe('array');
    expect(accountProperties.dmAllowlist?.type).toBe('array');
    expect(accountProperties.groupAllowFrom?.type).toBe('array');
    expect(accountProperties.groups?.type).toBe('array');
    expect(accountProperties.actions?.properties?.reactions?.type).toBe('boolean');

    for (const field of [
      'enabled',
      'port',
      'dmPolicy',
      'groupPolicy',
      'sendReadReceipts',
    ] as const) {
      expect(accountProperties[field]).not.toHaveProperty('default');
      expect(runtimeOverrideProperties[field]).not.toHaveProperty('default');
    }
  });

  it('marks root and wildcard password hints as sensitive outside JSON Schema', () => {
    expect(uiHints.password?.sensitive).toBe(true);
    expect(uiHints['accounts.*.password']?.sensitive).toBe(true);
    expect(uiHints['accounts.*.enabled']?.placeholder).toBe('Inherit root setting');
    expect(uiHints['accounts.*.sendReadReceipts']?.placeholder).toBe(
      'Inherit root setting'
    );
    expect(rootProperties.password).not.toHaveProperty('sensitive');
    expect(accountProperties.password).not.toHaveProperty('sensitive');
  });

  it('declares the principal wildcard UI hints for named accounts', () => {
    for (const field of accountFieldNames) {
      expect(uiHints).toHaveProperty(`accounts.*.${field}`);
    }
    expect(uiHints).toHaveProperty('accounts.*.actions.reactions');
  });

  it('keeps runtime schema fields, defaults, and UI hints aligned', () => {
    const runtimeJsonSchema = XmppConfigSchema.toJSONSchema({
      target: 'draft-07',
      io: 'input',
    }) as JsonSchema;
    const runtimeRootProperties = runtimeJsonSchema.properties ?? {};
    const runtimeAccountSchema = runtimeRootProperties.accounts?.additionalProperties as JsonSchema;

    expect(XmppAccountSchema.shape).toHaveProperty('enabled');
    expect(XmppAccountOverrideSchema.shape).toHaveProperty('enabled');
    expect(XmppConfigSchema.shape).toHaveProperty('enabled');
    expect(Object.keys(rootProperties).sort()).toEqual(Object.keys(runtimeRootProperties).sort());
    expect(Object.keys(accountProperties).sort()).toEqual(
      Object.keys(runtimeAccountSchema.properties ?? {}).sort()
    );
    expect(XmppConfigSchema.parse({})).toMatchObject({
      enabled: true,
      port: 5222,
      dmPolicy: 'pairing',
      groupPolicy: 'allowlist',
      sendReadReceipts: true,
    });
    expect(xmppChannelConfigSchema().uiHints).toEqual(xmppConfigUiHints);
    expect(uiHints).toEqual(xmppConfigUiHints);
  });

  it('does not materialize root defaults inside a partial named account', () => {
    const parsed = XmppConfigSchema.parse({
      enabled: false,
      port: 5223,
      dmPolicy: 'disabled',
      groupPolicy: 'open',
      sendReadReceipts: false,
      accounts: {
        secondary: { jid: 'bot@example.com' },
      },
    });

    expect(parsed.accounts?.secondary).toEqual({ jid: 'bot@example.com' });
  });

  it('resolves missing named fields from root and lets explicit overrides win', () => {
    const parsed = XmppConfigSchema.parse({
      enabled: false,
      port: 5223,
      dmPolicy: 'disabled',
      groupPolicy: 'allowlist',
      sendReadReceipts: false,
      accounts: {
        inherited: { jid: 'bot@example.com' },
        overridden: {
          jid: 'bot@example.com',
          enabled: true,
          port: 5224,
          dmPolicy: 'open',
          groupPolicy: 'open',
          sendReadReceipts: true,
        },
      },
    });
    const cfg = { channels: { xmpp: parsed } } as Parameters<
      typeof resolveXmppAccount
    >[0]['cfg'];

    const inherited = resolveXmppAccount({ cfg, accountId: 'inherited' });
    expect(inherited.enabled).toBe(false);
    expect(inherited.config).toMatchObject({
      port: 5223,
      dmPolicy: 'disabled',
      groupPolicy: 'allowlist',
      sendReadReceipts: false,
    });

    const overridden = resolveXmppAccount({ cfg, accountId: 'overridden' });
    expect(overridden.enabled).toBe(true);
    expect(overridden.config).toMatchObject({
      port: 5224,
      dmPolicy: 'open',
      groupPolicy: 'open',
      sendReadReceipts: true,
    });
  });

  it('distinguishes omitted named arrays from explicit empty overrides', () => {
    const parsed = XmppConfigSchema.parse({
      allowFrom: ['user@example.com'],
      dmAllowlist: ['user@example.com'],
      groupAllowFrom: ['user@example.com'],
      groups: ['room@conference.example.com'],
      accounts: {
        inherited: { jid: 'bot@example.com' },
        empty: {
          jid: 'bot@example.com',
          allowFrom: [],
          dmAllowlist: [],
          groupAllowFrom: [],
          groups: [],
        },
      },
    });
    const cfg = { channels: { xmpp: parsed } } as Parameters<
      typeof resolveXmppAccount
    >[0]['cfg'];

    expect(resolveXmppAccount({ cfg, accountId: 'inherited' }).config).toMatchObject({
      allowFrom: ['user@example.com'],
      dmAllowlist: ['user@example.com'],
      groupAllowFrom: ['user@example.com'],
      groups: ['room@conference.example.com'],
    });
    expect(resolveXmppAccount({ cfg, accountId: 'empty' }).config).toMatchObject({
      allowFrom: [],
      dmAllowlist: [],
      groupAllowFrom: [],
      groups: [],
    });
  });

  it('does not expose removed runtime features in the channel schema', () => {
    const serializedSchemas = JSON.stringify({
      manifest: channelSchema,
      runtimeRootFields: Object.keys(XmppConfigSchema.shape),
      runtimeAccountFields: Object.keys(XmppAccountSchema.shape),
    }).toLowerCase();

    for (const removed of [
      'omemo',
      'libsignal',
      'curve25519',
      'xep-0384',
      'xep-0454',
      'http-upload',
      'file-read',
      'downloadurl',
      'readlocalfile',
      'readfileurl',
    ]) {
      expect(serializedSchemas).not.toContain(removed);
    }
  });

  it('pins package compatibility metadata to OpenClaw 2026.8.2', () => {
    expect(packageJson.peerDependencies.openclaw).toBe('^2026.8.2');
    expect(packageJson.openclaw.compat.pluginApi).toBe('>=2026.8.2');
    expect(packageJson.openclaw.build.openclawVersion).toBe('2026.8.2');
  });
});

describe('OpenClaw heartbeat visibility contract', () => {
  it('accepts object overrides without materializing omitted named settings', () => {
    expect(XmppConfigSchema.parse({})).not.toHaveProperty('heartbeatVisibility');

    const parsed = XmppConfigSchema.parse({
      heartbeatVisibility: {
        showOk: false,
        showAlerts: true,
        useIndicator: true,
      },
      accounts: {
        inherited: { jid: 'bot@example.com' },
        overridden: {
          jid: 'bot@example.com',
          heartbeatVisibility: { showOk: true },
        },
      },
    });

    expect(parsed.heartbeatVisibility).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
    expect(parsed.accounts?.inherited).not.toHaveProperty('heartbeatVisibility');
    expect(parsed.accounts?.overridden?.heartbeatVisibility).toEqual({ showOk: true });
  });

  it.each(['visible', 'hidden'])('rejects the legacy %s string', (legacyValue) => {
    expect(
      XmppConfigSchema.safeParse({ heartbeatVisibility: legacyValue }).success
    ).toBe(false);
  });

  it('rejects unknown heartbeat visibility properties', () => {
    expect(
      XmppConfigSchema.safeParse({
        heartbeatVisibility: { showOk: true, unknown: true },
      }).success
    ).toBe(false);
  });

  it('publishes closed object schemas without legacy enums or defaults', () => {
    const rootHeartbeat = rootProperties.heartbeatVisibility;
    const namedHeartbeat = accountProperties.heartbeatVisibility;

    for (const heartbeatSchema of [rootHeartbeat, namedHeartbeat]) {
      expect(heartbeatSchema?.type).toBe('object');
      expect(heartbeatSchema?.additionalProperties).toBe(false);
      expect(heartbeatSchema?.properties).toMatchObject({
        showOk: { type: 'boolean' },
        showAlerts: { type: 'boolean' },
        useIndicator: { type: 'boolean' },
      });
      for (const subfield of ['showOk', 'showAlerts', 'useIndicator']) {
        expect(heartbeatSchema?.properties?.[subfield]).not.toHaveProperty('default');
      }
      expect(heartbeatSchema).not.toHaveProperty('default');
      expect(heartbeatSchema).not.toHaveProperty('enum');
    }

    expect(JSON.stringify({ rootHeartbeat, namedHeartbeat })).not.toMatch(
      /"(?:visible|hidden)"/
    );
  });

  it('publishes root and wildcard UI hints for every heartbeat subfield', () => {
    for (const subfield of ['showOk', 'showAlerts', 'useIndicator']) {
      expect(uiHints).toHaveProperty(`heartbeatVisibility.${subfield}`);
      expect(uiHints).toHaveProperty(`accounts.*.heartbeatVisibility.${subfield}`);
      expect(uiHints[`heartbeatVisibility.${subfield}`]?.placeholder).toBe(
        'Inherit OpenClaw setting'
      );
      expect(uiHints[`accounts.*.heartbeatVisibility.${subfield}`]?.placeholder).toBe(
        'Inherit root setting'
      );
    }
    expect(uiHints.heartbeatVisibility?.advanced).toBe(true);
    expect(uiHints['accounts.*.heartbeatVisibility']?.advanced).toBe(true);
  });
});
