// Exact-host characterization: real SDK schemas/routing/channel manager, fake XMPP clients.
// Never load the user's config or credentials. Build the plugin before running.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const host = resolve(process.argv[2] ?? join(repository, 'node_modules/openclaw'));
const version = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).version;
assert.ok(['2026.8.2', '2026.9.9'].includes(version), 'Characterize other SDK versions explicitly');
if (version === '2026.9.9') {
  const build = JSON.parse(readFileSync(join(host, 'dist/build-info.json'), 'utf8'));
  assert.equal(build.commit, 'bcfc88812a35243893585dbeca87ca41b48272ca');
}
const temporary = await mkdtemp(join(tmpdir(), 'xmpp-default-account-'));
process.env.OPENCLAW_STATE_DIR = temporary;
process.env.OPENCLAW_CONFIG_PATH = join(temporary, 'unused-config.json');
process.env.OPENCLAW_AUTH_STORE_READONLY = '1';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('openclaw/plugin-sdk/')) {
      return next(specifier, {
        ...context,
        parentURL: pathToFileURL(join(host, 'package.json')).href,
      });
    }
    return next(specifier, context);
  },
});

// Private discovery stays in this characterization script, never in plugin code.
async function hostExport(name) {
  for (const file of readdirSync(join(host, 'dist'))) {
    if (!/\.m?js$/.test(file)) continue;
    const source = readFileSync(join(host, 'dist', file), 'utf8');
    if (!source.includes(`function ${name}(`) && !source.includes(`const ${name} =`)) continue;
    const match = source.match(new RegExp(`export \\{[^}]*\\b${name}(?: as (\\w+))?[, }]`));
    if (match) return (await import(pathToFileURL(join(host, 'dist', file))))[match[1] ?? name];
  }
  throw new Error(`Missing characterized host export: ${name}`);
}

try {
  const { xmppPlugin } = await import('../dist/src/channel.js');
  const { XmppConfigSchema } = await import('../dist/src/config-schema.js');
  const { activeClients } = await import('../dist/src/state.js');
  const { handleInboundMessage } = await import('../dist/src/inbound.js');
  const { setXmppRuntime } = await import('../dist/src/runtime.js');
  const { resolveAgentRoute } = await import('openclaw/plugin-sdk/routing');
  const { buildJsonChannelConfigSchema } =
    await import('openclaw/plugin-sdk/channel-config-schema');
  const defaultId = await hostExport('resolveChannelDefaultAccountId');
  const warnings = await hostExport('collectMissingExplicitDefaultAccountWarnings');
  const manifest = JSON.parse(readFileSync(join(repository, 'openclaw.plugin.json'), 'utf8'));
  const cold = buildJsonChannelConfigSchema(manifest.channelConfigs.xmpp.schema);

  await test(`${version}: real SDK schema conversion and semantic validation`, () => {
    assert.ok(XmppConfigSchema.shape.defaultAccount);
    assert.deepEqual(
      xmppPlugin.configSchema.schema.properties.defaultAccount,
      cold.schema.properties.defaultAccount
    );
    for (const defaultAccount of ['secondary', 'main']) {
      const value = { defaultAccount, accounts: { secondary: {}, main: {} } };
      assert.equal(cold.runtime.safeParse(value).success, true);
      assert.equal(xmppPlugin.configSchema.runtime.safeParse(value).success, true);
    }
    for (const defaultAccount of ['', ' ', 'main\n', 'MAIN', 'constructor', null, 42]) {
      const value = { defaultAccount, accounts: { main: {} } };
      assert.equal(cold.runtime.safeParse(value).success, false);
      assert.equal(xmppPlugin.configSchema.runtime.safeParse(value).success, false);
    }
    assert.equal(
      xmppPlugin.configSchema.runtime.safeParse({
        defaultAccount: 'missing',
        accounts: { main: {} },
      }).success,
      false
    );
    assert.equal(
      xmppPlugin.configSchema.runtime.safeParse({ accounts: { main: { defaultAccount: 'main' } } })
        .success,
      false
    );
  });

  const createManager = await hostExport('createChannelManager');
  const createRegistry = await hostExport('createEmptyPluginRegistry');
  // 2026.8.2 reads the active registry; 2026.9.9 accepts the scoped registry getter.
  const setRegistry = await hostExport('setActivePluginRegistry');
  for (const preferred of ['secondary', 'main']) {
    await test(
      `${version}: ${preferred}, two lifecycles, outbound and actual multiagent bindings`,
      { timeout: 30_000 },
      async () => {
        const accounts = Object.fromEntries(
          ['secondary', 'main'].map((id) => [
            id,
            {
              jid: `${id}@example.com`,
              password: 'isolated-fixture',
              dmPolicy: 'allowlist',
              dmAllowlist: ['peer@example.com'],
              sendReadReceipts: false,
              actions: { reactions: true },
            },
          ])
        );
        const cfg = {
          agents: {
            ownership: 'explicit',
            defaults: { systemAgent: { agentId: 'main' } },
            list: [{ id: 'secondary' }, { id: 'main' }],
          },
          bindings: ['secondary', 'main'].map((id) => ({
            agentId: id,
            match: { channel: 'xmpp', accountId: id },
          })),
          session: { dmScope: 'per-account-channel-peer' },
          channels: { xmpp: { defaultAccount: preferred, accounts } },
        };
        const before = structuredClone(cfg);
        const started = [];
        const sent = [];
        const inbound = [];
        const recorded = [];
        const registry = createRegistry();
        registry.channels.push({
          pluginId: 'xmpp',
          source: 'fixture',
          plugin: {
            ...xmppPlugin,
            gateway: {
              startAccount: async ({ accountId, abortSignal }) => {
                started.push(accountId);
                activeClients.set(accountId, {
                  send: async (stanza) => sent.push({ accountId, stanza }),
                });
                await new Promise((done) =>
                  abortSignal.addEventListener('abort', done, { once: true })
                );
                activeClients.delete(accountId);
              },
            },
          },
        });
        setRegistry(registry);
        const manager = createManager({
          getRuntimeConfig: () => cfg,
          getPluginRegistry: () => registry,
          channelLogs: {},
          channelRuntimeEnvs: {},
        });
        setXmppRuntime({
          channel: {
            routing: { resolveAgentRoute },
            session: {
              resolveStorePath: (_store, { agentId }) => join(temporary, agentId),
              recordInboundSession: async (params) => recorded.push(params),
            },
            reply: {
              finalizeInboundContext: (value) => value,
              dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }) => {
                inbound.push(ctx);
                return { queuedFinal: false };
              },
            },
          },
        });
        try {
          assert.equal(defaultId({ cfg, plugin: xmppPlugin }), preferred);
          assert.equal(warnings(cfg).length, 0);
          assert.equal(
            defaultId({
              cfg: {
                ...cfg,
                channels: {
                  xmpp: {
                    defaultAccount: preferred,
                    accounts: { main: accounts.main, secondary: accounts.secondary },
                  },
                },
              },
              plugin: xmppPlugin,
            }),
            preferred
          );
          await manager.startChannel('xmpp');
          assert.deepEqual(started.slice().sort(), ['main', 'secondary']);
          assert.deepEqual([...activeClients.keys()].sort(), ['main', 'secondary']);
          await xmppPlugin.outbound.sendText({ cfg, to: 'peer@example.com', text: 'fixture' });
          assert.equal(sent.at(-1).accountId, preferred);
          const explicit = preferred === 'secondary' ? 'main' : 'secondary';
          await xmppPlugin.outbound.sendText({
            cfg,
            accountId: explicit,
            to: 'peer@example.com',
            text: 'explicit fixture',
          });
          assert.equal(sent.at(-1).accountId, explicit);
          await xmppPlugin.actions.handleAction({
            cfg,
            action: 'react',
            params: { chatJid: 'peer@example.com', messageId: 'fixture', emoji: '👍' },
          });
          assert.equal(sent.at(-1).accountId, preferred);
          for (const id of ['secondary', 'main']) {
            const route = resolveAgentRoute({
              cfg,
              channel: 'xmpp',
              accountId: id,
              peer: { kind: 'direct', id: 'peer@example.com' },
            });
            assert.equal(route.agentId, id);
            await handleInboundMessage(
              {
                id: `message-${id}`,
                from: 'peer@example.com',
                to: accounts[id].jid,
                body: 'fixture',
                type: 'chat',
                timestamp: 1,
                isGroup: false,
              },
              cfg,
              id,
              accounts[id]
            );
            assert.equal(inbound.at(-1).AccountId, id);
            assert.equal(inbound.at(-1).SessionKey, route.sessionKey);
            assert.equal(recorded.at(-1).updateLastRoute.accountId, id);
          }
          assert.notEqual(inbound[0].SessionKey, inbound[1].SessionKey);
          const count = sent.length;
          await manager.stopChannel('xmpp', preferred);
          await assert.rejects(
            xmppPlugin.outbound.sendText({
              cfg,
              to: 'peer@example.com',
              text: 'must not fail over',
            }),
            /not connected/
          );
          assert.equal(sent.length, count);
          assert.equal(started.length, 2);
          assert.deepEqual(cfg, before);
        } finally {
          await manager.stopChannel('xmpp');
          activeClients.clear();
        }
      }
    );
  }
} finally {
  hooks.deregister();
  await rm(temporary, { recursive: true, force: true });
}
