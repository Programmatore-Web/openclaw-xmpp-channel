// Characterize exact OpenClaw artifacts with a packed external plugin. Only the
// XMPP network boundary is fake; discovery, providers, snapshots and Gateway are real.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const host = resolve(process.argv[2] ?? join(repository, 'node_modules/openclaw'));
const version = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).version;
assert.ok(
  ['2026.8.2', '2026.9.5'].includes(version),
  'Revalidate characterization for other hosts'
);
const temporary = await mkdtemp(join(tmpdir(), 'xmpp-secret-runtime-'));
process.env.OPENCLAW_STATE_DIR = join(temporary, 'state');
process.env.OPENCLAW_CONFIG_PATH = join(temporary, 'unused-config.json');
process.env.OPENCLAW_AUTH_STORE_READONLY = '1';
delete process.env.XMPP_TEST_PASSWORD;
delete process.env.XMPP_MISSING_PASSWORD;
const sentinel = 'test-secret-value-DO-NOT-LOG';

// Private bundle discovery is confined to this characterization, following the
// existing D3 harness. Plugin production imports remain public SDK imports only.
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
let hooks;
let clearSecrets;
try {
  const [pack] = JSON.parse(
    (
      await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], {
        cwd: repository,
      })
    ).stdout
  );
  for (const path of ['dist/secret-contract-api.js', 'dist/secret-contract-api.d.ts']) {
    assert.ok(
      pack.files.some((file) => file.path === path),
      `Missing packed artifact: ${path}`
    );
  }
  assert.ok(
    pack.files.every(({ path }) => !/^(?:test|scripts)\//.test(path) && !path.endsWith('.tgz'))
  );
  await exec('tar', ['-xf', join(temporary, pack.filename), '-C', temporary]);
  const pluginRoot = join(temporary, 'package');
  await symlink(join(repository, 'node_modules'), join(pluginRoot, 'node_modules'));
  await mkdir(process.env.OPENCLAW_STATE_DIR);
  let makeClient;
  globalThis[Symbol.for('xmpp.secret.test.client')] = (options) => makeClient(options);
  const boundary = pathToFileURL(join(pluginRoot, 'dist/src/xmpp.js')).href;
  hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('openclaw/plugin-sdk/')) {
        return next(specifier, {
          ...context,
          parentURL: pathToFileURL(join(host, 'package.json')).href,
        });
      }
      if (specifier === './xmpp.js' && context.parentURL?.endsWith('/dist/src/monitor.js')) {
        return { url: 'xmpp-secret:client', shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === 'xmpp-secret:client')
        return {
          format: 'module',
          shortCircuit: true,
          source: `export { xml } from ${JSON.stringify(boundary)};
          export const client = (options) => globalThis[Symbol.for('xmpp.secret.test.client')](options);`,
        };
      return next(url, context);
    },
  });
  const prepare = await hostExport('prepareSecretsRuntimeSnapshot');
  const activate = await hostExport('activateSecretsRuntimeSnapshot');
  clearSecrets = await hostExport('clearSecretsRuntimeSnapshot');
  const loadContract = await hostExport('loadChannelSecretContractApi');
  const createManager = await hostExport('createChannelManager');
  const createRegistry = await hostExport('createEmptyPluginRegistry');
  const setRegistry = await hostExport('setActivePluginRegistry');
  const writeStore = await hostExport('writeSecretStoreEntry');
  const { xmppPlugin } = await import(pathToFileURL(join(pluginRoot, 'dist/src/channel.js')));
  const { xml } = await import(boundary);
  const { accountLifecycles } = await import(pathToFileURL(join(pluginRoot, 'dist/src/state.js')));
  const { setXmppRuntime } = await import(pathToFileURL(join(pluginRoot, 'dist/src/runtime.js')));
  setXmppRuntime({ channel: { activity: { record: () => {} } } });
  const rootRef = { source: 'store', provider: 'default', id: 'XMPP_TEST_PASSWORD' };
  writeStore({
    scope: { kind: 'team' },
    name: 'XMPP_TEST_PASSWORD',
    value: sentinel,
    kind: 'secret',
    updatedBy: 'test',
  });

  for (const [label, password, missing] of [
    ['plaintext', '  opaque plaintext  ', false],
    ['env shorthand', '${XMPP_TEST_PASSWORD}', false],
    ['short env shorthand', '$XMPP_TEST_PASSWORD', false],
    ['env ref', { ...rootRef, source: 'env' }, false],
    ['store ref', rootRef, false],
    ['missing store', { ...rootRef, id: 'XMPP_MISSING_PASSWORD' }, true],
    ['missing env', { ...rootRef, source: 'env', id: 'XMPP_MISSING_PASSWORD' }, true],
  ])
    await test(
      `${version}: packed contract / ${label} / Gateway / SASL`,
      { timeout: 30_000 },
      async () => {
        clearSecrets();
        const source = {
          plugins: {
            allow: ['xmpp'],
            load: { paths: [pluginRoot] },
            entries: { xmpp: { enabled: true } },
          },
          channels: {
            xmpp: {
              jid: 'bot@example.com',
              password,
              groups: [],
              accounts: {
                secondary: { jid: 'user@example.com', password: { ...rootRef, source: 'env' } },
              },
            },
          },
        };
        const original = structuredClone(source);
        const contract = loadContract({ channelId: 'xmpp', config: source });
        assert.equal(typeof contract?.collectRuntimeConfigAssignments, 'function');
        assert.equal(contract.secretTargetRegistryEntries.length, 2);
        const snapshot = await prepare({
          config: source,
          env: { ...process.env, XMPP_TEST_PASSWORD: sentinel },
          includeAuthStoreRefs: false,
          allowUnavailableSecretOwners: true,
        });
        assert.deepEqual(source, original);
        assert.deepEqual(snapshot.sourceConfig, original);
        const expected = label === 'plaintext' ? password : sentinel;
        if (!missing)
          assert.ok(
            snapshot.config.channels.xmpp.password === expected,
            'Runtime materialization mismatch'
          );
        assert.ok(snapshot.config.channels.xmpp.accounts.secondary.password === sentinel);
        assert.deepEqual(
          snapshot.degradedOwners.map((owner) => [owner.ownerId, owner.state]),
          missing ? [['xmpp:default', 'unavailable']] : []
        );
        activate(snapshot);

        const output = [];
        const log = Object.fromEntries(
          ['info', 'warn', 'debug', 'error'].map((level) => [level, (...args) => output.push(args)])
        );
        const authentications = [];
        let constructions = 0;
        makeClient = (options) => {
          constructions++;
          const entity = Object.assign(new EventEmitter(), {
            status: 'offline',
            options,
            reconnect: { stop() {} },
            isSecure: () => true,
            connect: async () => {},
            stop: async () => {},
            open: async () => {
              await options.credentials(
                async (credentials, mechanism) => {
                  assert.equal(mechanism, 'SCRAM-SHA-1');
                  assert.ok(
                    credentials.password === (options.username === 'bot' ? expected : sentinel),
                    'SASL password mismatch'
                  );
                  authentications.push(credentials.password);
                },
                ['PLAIN', 'SCRAM-SHA-1'],
                undefined,
                entity
              );
              entity.status = 'online';
              entity.emit('online', { toString: () => `${options.username}@example.com/test` });
            },
            send: async (stanza) => {
              if (stanza.getChild('query', 'jabber:iq:roster'))
                queueMicrotask(() =>
                  entity.emit(
                    'stanza',
                    xml(
                      'iq',
                      { type: 'result', id: stanza.attrs.id },
                      xml('query', { xmlns: 'jabber:iq:roster' })
                    )
                  )
                );
            },
          });
          return entity;
        };
        const registry = createRegistry();
        let started = 0;
        const plugin = {
          ...xmppPlugin,
          gateway: {
            startAccount: (ctx) => {
              started++;
              assert.ok(typeof ctx.account.config.password === 'string');
              return xmppPlugin.gateway.startAccount(ctx);
            },
          },
        };
        registry.channels.push({ pluginId: 'xmpp', plugin, source: 'fixture' });
        setRegistry(registry);
        const manager = createManager({
          getRuntimeConfig: () => snapshot.config,
          getPluginRegistry: () => registry,
          channelLogs: { xmpp: log },
          channelRuntimeEnvs: {},
        });
        try {
          await manager.startChannel('xmpp', undefined, { skipUnavailableAccounts: true });
          for (
            let attempt = 0;
            attempt < 100 && authentications.length < (missing ? 1 : 2);
            attempt++
          )
            await new Promise((done) => setTimeout(done, 10));
          assert.equal(started, missing ? 1 : 2);
          assert.equal(constructions, missing ? 1 : 2);
          assert.equal(authentications.length, missing ? 1 : 2);
          assert.ok(authentications.every((value) => value === expected || value === sentinel));
          if (missing) {
            const status = manager.getRuntimeSnapshot().channelAccounts.xmpp.default;
            assert.equal(status.running, false);
          } else {
            const owner = accountLifecycles.get('default');
            assert.ok(owner);
            const admitted = owner.ctx;
            // The existing lifecycle restart is the fresh-client reconnect boundary.
            // Removing ENV after preparation must not trigger a second lookup.
            delete process.env.XMPP_TEST_PASSWORD;
            await owner.start();
            assert.equal(owner.ctx, admitted);
            assert.ok(authentications.at(-1) === expected);
          }
          const account = xmppPlugin.config.resolveAccount(snapshot.config, 'default');
          const summary = await xmppPlugin.status.buildChannelSummary({ account });
          const status = await xmppPlugin.status.buildAccountSnapshot({ account });
          assert.ok(
            !JSON.stringify([
              output,
              summary,
              status,
              snapshot.warnings,
              snapshot.degradedOwners,
              manager.getRuntimeSnapshot(),
              source,
            ]).includes(sentinel),
            'Secret leaked into public output'
          );
          assert.deepEqual(source, original);
        } finally {
          await manager.stopChannel('xmpp');
          clearSecrets();
        }
      }
    );
} finally {
  clearSecrets?.();
  hooks?.deregister();
  delete globalThis[Symbol.for('xmpp.secret.test.client')];
  await rm(temporary, { recursive: true, force: true });
}
