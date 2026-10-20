// Exact-host checkpoint probe. Install the packed plugin and a characterized SDK
// in a disposable npm consumer first; this does not build or install packages.
// The host's reviewed package lifecycle must be complete for its public CLI.
// Defaults to 2026.10.5; pass 2026.8.2 or 2026.9.9 as the second argument.
// Each host retains the same public inspect command, JSON/runtime schema contract
// and four-method run-state contract. Their different export/Zod graphs are asserted.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
assert.ok(process.argv[2], 'Pass the disposable consumer directory, not an OpenClaw config');
const version = process.argv[3] ?? '2026.10.5';
assert.ok(['2026.8.2', '2026.9.9', '2026.10.5'].includes(version), 'Uncharacterized SDK version');
const consumer = await realpath(resolve(process.argv[2]));
assert.ok(
  consumer.startsWith((await realpath(tmpdir())) + sep),
  'Use a consumer under the temporary directory'
);
const host = await realpath(join(consumer, 'node_modules/openclaw'));
const pluginRoot = await realpath(join(consumer, 'node_modules/@openclaw/xmpp'));
const metadata = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
assert.equal(metadata.exports['.'].import, './dist/index.js');
const entry = join(pluginRoot, metadata.exports['.'].import);
assert.ok(host.startsWith(consumer + sep), 'The SDK must be installed inside the consumer');
assert.ok(entry.startsWith(consumer + sep), 'The packed plugin must be installed in the consumer');
assert.equal(JSON.parse(await readFile(join(host, 'package.json'), 'utf8')).version, version);
const temporary = await mkdtemp(join(consumer, '.xmpp-openclaw-2026-10-5-'));

// This function is serialized into the isolated child; it has no outer bindings.
async function probe(consumer, version) {
  const { default: assert } = await import('node:assert/strict');
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { Socket } = await import('node:net');
  const require = createRequire(join(consumer, 'package.json'));
  const hostRequire = createRequire(join(consumer, 'node_modules/openclaw/package.json'));
  assert.equal(
    JSON.parse(readFileSync(join(consumer, 'node_modules/openclaw/package.json'), 'utf8')).version,
    version
  );
  const modern = version === '2026.10.5';
  const sdkPath = `openclaw/plugin-sdk/${modern ? 'channel-outbound' : 'channel-lifecycle'}`;
  if (modern) {
    assert.throws(() => require.resolve('openclaw/plugin-sdk/channel-lifecycle'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  }
  const entry = new URL(import.meta.resolve('@openclaw/xmpp'));
  const pluginRequire = createRequire(entry);
  const pluginZod = JSON.parse(readFileSync(pluginRequire.resolve('zod/package.json'), 'utf8'));
  const hostZod = JSON.parse(readFileSync(hostRequire.resolve('zod/package.json'), 'utf8'));
  assert.equal(pluginZod.version, '4.6.5');
  assert.equal(hostZod.version, version === '2026.8.2' ? '4.4.3' : '4.6.5');
  // Load the plugin synchronously before evaluating any SDK module in the probe.
  const required = require(fileURLToPath(entry));
  assert.equal('createRunStateMachine' in require('openclaw/plugin-sdk/channel-outbound'), modern);
  const imported = await import('@openclaw/xmpp');
  assert.equal(required.default, imported.default, 'Native synchronous and ESM loaders agree');
  assert.equal(imported.default.id, 'xmpp');
  const secretContract = await import(new URL('./secret-contract-api.js', entry));
  assert.equal(typeof secretContract.collectRuntimeConfigAssignments, 'function');
  assert.equal(secretContract.secretTargetRegistryEntries.length, 2);
  const { inspectXmppRuntime } = await import(new URL('./src/xmpp-runtime-compat.js', entry));
  const diagnostics = inspectXmppRuntime();
  assert.equal(new Set(diagnostics.map((item) => item.package)).size, 28);
  assert.ok(diagnostics.every((item) => item.status === 'validated' && item.version === '0.14.0'));
  const { client, xml } = await import(new URL('./src/xmpp.js', entry));
  const entity = client({ service: 'xmpp://example.com:5222', domain: 'example.com' });
  entity.reconnect.stop();
  assert.equal(xml('presence').name, 'presence');

  const { createRunStateMachine } = await import(new URL('./src/sdk-run-state.js', entry));
  assert.equal(
    createRunStateMachine,
    require(sdkPath).createRunStateMachine,
    'The packed plugin selects the original SDK factory, without a wrapper or simulation'
  );
  assert.equal(
    pluginRequire(fileURLToPath(new URL('./src/sdk-run-state.js', entry))).createRunStateMachine,
    createRunStateMachine
  );
  const updates = [];
  const controller = new AbortController();
  const tracker = createRunStateMachine({
    abortSignal: controller.signal,
    setStatus: (patch) => updates.push(patch),
    now: () => 123,
    heartbeatMs: 5,
  });
  assert.deepEqual(updates.at(-1), { activeRuns: 0, busy: false });
  tracker.onRunStart();
  tracker.onRunStart();
  assert.deepEqual(updates.at(-1), { activeRuns: 2, busy: true, lastRunActivityAt: 123 });
  tracker.onRunEnd();
  assert.equal(updates.at(-1).activeRuns, 1);
  tracker.onRunEnd();
  tracker.onRunEnd();
  assert.equal(updates.at(-1).activeRuns, 0);
  tracker.onRunStart();
  const beforeHeartbeat = updates.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(updates.length > beforeHeartbeat, 'The real SDK owns the active-run heartbeat');
  controller.abort();
  const count = updates.length;
  tracker.onRunStart();
  tracker.onRunEnd();
  tracker.deactivate();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tracker.isActive(), false);
  assert.equal(updates.length, count, 'Retired runs must not publish status');
  const retired = createRunStateMachine({
    setStatus: (patch) => updates.push(patch),
    heartbeatMs: 5,
  });
  retired.onRunStart();
  retired.deactivate();
  const retiredCount = updates.length;
  retired.onRunEnd();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(retired.isActive(), false);
  assert.equal(updates.length, retiredCount, 'Explicit deactivation cancels heartbeats');
  const preAborted = createRunStateMachine({
    abortSignal: controller.signal,
    setStatus: () => assert.fail('Pre-aborted tracker published status'),
  });
  assert.equal(preAborted.isActive(), false);
  preAborted.onRunStart();
  preAborted.onRunEnd();
  preAborted.deactivate();

  const accounts = Object.fromEntries(
    ['main', 'secondary'].map((id) => [
      id,
      {
        jid: `${id}@example.com`,
        password: { source: 'env', provider: 'default', id: `XMPP_TEST_${id.toUpperCase()}` },
      },
    ])
  );
  const cfg = {
    agents: {
      ownership: 'explicit',
      defaults: { systemAgent: { agentId: 'main' } },
      list: [{ id: 'main' }, { id: 'secondary' }],
    },
    bindings: ['main', 'secondary'].map((id) => ({
      agentId: id,
      match: { channel: 'xmpp', accountId: id },
    })),
    session: { dmScope: 'per-account-channel-peer' },
    channels: { xmpp: { defaultAccount: 'secondary', accounts } },
  };
  const before = structuredClone(cfg);
  const parsed = imported.xmppPlugin.configSchema.runtime.safeParse(cfg.channels.xmpp);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.dmPolicy, 'pairing');
  assert.equal(parsed.data.groupPolicy, 'allowlist');
  assert.equal(imported.resolveDefaultXmppAccountId(cfg), 'secondary');
  assert.equal(imported.resolveXmppAccount({ cfg, accountId: 'main' }).accountId, 'main');
  assert.equal(
    imported.xmppPlugin.configSchema.runtime.safeParse({
      ...cfg.channels.xmpp,
      defaultAccount: 'missing',
    }).success,
    false
  );
  assert.equal(
    imported.xmppPlugin.configSchema.runtime.safeParse({
      accounts: { main: { defaultAccount: 'main' } },
    }).success,
    false
  );
  const { resolveAgentRoute } = require('openclaw/plugin-sdk/routing');
  const routes = ['main', 'secondary'].map((accountId) => {
    const route = resolveAgentRoute({
      cfg,
      channel: 'xmpp',
      accountId,
      peer: { kind: 'direct', id: 'peer@example.com' },
    });
    assert.equal(route.agentId, accountId);
    return route.sessionKey;
  });
  assert.notEqual(routes[0], routes[1]);
  assert.deepEqual(cfg, before, 'SecretRefs and account bindings remain unchanged');

  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', entry), 'utf8'));
  const { buildJsonChannelConfigSchema } = require('openclaw/plugin-sdk/channel-config-schema');
  const cold = buildJsonChannelConfigSchema(manifest.channelConfigs.xmpp.schema);
  const runtime = imported.xmppPlugin.configSchema;
  const { XmppConfigSchema } = await import(new URL('./src/config-schema.js', entry));
  const reference = require('openclaw/plugin-sdk/core').buildChannelConfigSchema(XmppConfigSchema, {
    uiHints: runtime.uiHints,
    jsonSchemaMode: 'input',
  });
  assert.deepEqual(
    runtime.schema,
    reference.schema,
    'JSON schema conversion preserves the SDK contract'
  );
  assert.deepEqual(runtime.uiHints, reference.uiHints);
  for (const value of [
    {},
    cfg.channels.xmpp,
    { defaultAccount: 'missing', accounts: { main: {} } },
    { accounts: { main: { defaultAccount: 'main' } } },
    { password: { source: 'invalid' } },
    { port: -1 },
  ]) {
    assert.deepEqual(runtime.runtime.safeParse(value), reference.runtime.safeParse(value));
  }
  const properties = runtime.schema.properties;
  assert.deepEqual(properties.password, cold.schema.properties.password);
  assert.deepEqual(properties.defaultAccount, cold.schema.properties.defaultAccount);
  for (const [field, expected] of [
    ['dmPolicy', 'pairing'],
    ['groupPolicy', 'allowlist'],
  ]) {
    assert.equal(properties[field].default, expected);
    assert.equal(cold.schema.properties[field].default, expected);
    assert.equal('default' in properties.accounts.additionalProperties.properties[field], false);
  }
  const rootRef = { source: 'store', provider: 'default', id: 'XMPP_TEST_ROOT' };
  for (const password of ['  opaque password \t', '$XMPP_LITERAL', '${XMPP_LITERAL}', rootRef]) {
    for (const defaultAccount of ['main', 'secondary']) {
      const value = {
        password,
        defaultAccount,
        accounts: {
          main: { jid: 'main@example.com', password: accounts.main.password },
          secondary: { jid: 'secondary@example.com' },
        },
      };
      const snapshot = structuredClone(value);
      assert.equal(cold.runtime.safeParse(value).success, true);
      const result = runtime.runtime.safeParse(value);
      assert.equal(result.success, true);
      const inheritedCfg = { channels: { xmpp: result.data } };
      assert.deepEqual(
        imported.resolveXmppAccount({ cfg: inheritedCfg, accountId: 'secondary' }).config.password,
        password
      );
      assert.deepEqual(
        imported.resolveXmppAccount({ cfg: inheritedCfg, accountId: 'main' }).config.password,
        accounts.main.password
      );
      assert.equal(imported.resolveXmppAccount({ cfg: inheritedCfg }).accountId, defaultAccount);
      assert.deepEqual(value, snapshot);
    }
  }
  for (const password of [42, {}, { ...rootRef, provider: '' }, { ...rootRef, extra: true }]) {
    assert.equal(cold.runtime.safeParse({ password }).success, false);
    assert.equal(runtime.runtime.safeParse({ password }).success, false);
  }
  const source = {
    channels: {
      xmpp: {
        password: rootRef,
        accounts: {
          main: { jid: 'main@example.com', password: accounts.main.password },
          secondary: { jid: 'secondary@example.com' },
        },
      },
    },
  };
  const context = {
    sourceConfig: source,
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
  secretContract.collectRuntimeConfigAssignments({ config: structuredClone(source), context });
  assert.equal(
    context.assignments.length,
    2,
    'Real SDK secret collector retains both account scopes'
  );
  assert.deepEqual(context.assignments.map(({ ownerId, path }) => [ownerId, path]).sort(), [
    ['xmpp:main', 'channels.xmpp.accounts.main.password'],
    ['xmpp:secondary', 'channels.xmpp.password'],
  ]);

  const { accountLifecycles, activeClients } = await import(new URL('./src/state.js', entry));
  let connections = 0;
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function () {
    connections++;
    throw new Error('Network connection forbidden in this probe');
  };
  try {
    for (const accountId of ['main', 'secondary']) {
      await imported.xmppPlugin.gateway.startAccount({
        cfg,
        accountId,
        account: {
          accountId,
          enabled: true,
          config: { jid: `${accountId}@example.com`, password: 'fixture' },
        },
        abortSignal: controller.signal,
        setStatus() {},
      });
    }
    assert.equal(connections, 0);
    assert.equal(accountLifecycles.size, 0);
    assert.equal(activeClients.size, 0);
  } finally {
    Socket.prototype.connect = connect;
  }
  console.log(
    JSON.stringify({
      sdk: version,
      sdkFactory: require.resolve(sdkPath),
      pluginZod: pluginZod.version,
      hostZod: hostZod.version,
      pluginEntry: fileURLToPath(entry),
      imported: true,
      secretContract: true,
      xmppPackages: 28,
      runTracker: 'pass',
      accounts: ['main', 'secondary'],
      abortedLifecycles: 'pass',
      connections,
    })
  );
}

// Node's permission model always disables fchmod, which the real loader needs.
// Guard path-based data I/O in the CLI child while retaining real SDK operations.
async function guardCli(consumer, temporary, version) {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const path = (await import('node:path')).default;
  const { resolve, sep } = path;
  const { fileURLToPath } = await import('node:url');
  const { Socket } = await import('node:net');
  if (version === '2026.8.2') {
    // This exact host hardcodes /tmp for SQLite lifecycle coordinator locks,
    // ignoring TMPDIR. Redirect only that path construction into the fixture;
    // retain real SQLite, locking and SDK operations, and the I/O guards below.
    const join = path.join;
    const suffix = `openclaw-state-locks-${process.getuid()}`;
    let redirects = 0;
    path.join = (...parts) => {
      if (parts[0] === '/tmp' && parts[1] === suffix) {
        redirects++;
        return join(temporary, 'legacy-state-locks', ...parts.slice(2));
      }
      return join(...parts);
    };
    process.on('exit', () => {
      console.error(`XMPP_FIXTURE_LEGACY_LOCK_REDIRECTS=${redirects}`);
    });
  }
  const check = (path, write) => {
    if (typeof path === 'number') return; // File descriptors opened through the guarded API.
    const value = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    const root = write ? temporary : consumer;
    if (value !== root && !value.startsWith(root + sep)) {
      throw new Error(
        `CLI data I/O outside the disposable fixture is forbidden (${write ? 'write' : 'read'}: ${value})`
      );
    }
  };
  for (const [name, write] of [
    ['readFile', false],
    ['readdir', false],
    ['opendir', false],
    ['writeFile', true],
    ['appendFile', true],
    ['mkdir', true],
    ['rm', true],
    ['rmdir', true],
    ['unlink', true],
    ['chmod', true],
  ]) {
    for (const [owner, key] of [
      [fs, name],
      [fs, `${name}Sync`],
      [fs.promises, name],
    ]) {
      if (typeof owner[key] !== 'function') continue;
      const original = owner[key];
      owner[key] = function (path, ...args) {
        check(path, write);
        return original.call(this, path, ...args);
      };
    }
  }
  for (const [owner, key] of [
    [fs, 'open'],
    [fs, 'openSync'],
    [fs.promises, 'open'],
  ]) {
    const original = owner[key];
    owner[key] = function (path, flags, ...args) {
      const writeFlags =
        fs.constants.O_WRONLY |
        fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_APPEND;
      check(
        path,
        typeof flags === 'number' ? Boolean(flags & writeFlags) : /[wa+]/.test(flags ?? 'r')
      );
      return original.call(this, path, flags, ...args);
    };
  }
  Socket.prototype.connect = function () {
    throw new Error('Network connection forbidden during CLI runtime inspection');
  };
  syncBuiltinESMExports();
}

try {
  const configPath = join(temporary, 'openclaw.json');
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        allow: ['xmpp'],
        load: { paths: [pluginRoot] },
        entries: { xmpp: { enabled: true } },
        slots: { memory: 'none' },
      },
    })
  );
  const env = {
    PATH: process.env.PATH,
    TMPDIR: temporary,
    OPENCLAW_HOME: temporary,
    OPENCLAW_STATE_DIR: join(temporary, 'state'),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_AUTH_STORE_READONLY: '1',
    OPENCLAW_NO_RESPAWN: '1',
    XDG_CONFIG_HOME: temporary,
    XDG_DATA_HOME: temporary,
    XDG_CACHE_HOME: temporary,
  };
  const permissions = [
    '--permission',
    `--allow-fs-read=${consumer}`,
    `--allow-fs-read=${temporary}`,
    `--allow-fs-write=${temporary}`,
  ];
  const options = { cwd: consumer, env, timeout: 90_000, maxBuffer: 4_000_000 };
  const probePath = join(temporary, 'probe.mjs');
  await writeFile(
    probePath,
    `await (${probe.toString()})(${JSON.stringify(consumer)}, ${JSON.stringify(version)});\n`
  );
  const direct = await exec(process.execPath, [...permissions, probePath], options);
  console.log(direct.stdout.trim());
  const guardPath = join(temporary, 'guard.mjs');
  await writeFile(
    guardPath,
    `await (${guardCli.toString()})(${JSON.stringify(consumer)}, ${JSON.stringify(temporary)}, ${JSON.stringify(version)});\n`
  );
  // Public CLI runtime inspection calls the real loader and registration API.
  // It does not start a Gateway or an XMPP account.
  const inspected = await exec(
    process.execPath,
    [
      '--import',
      guardPath,
      join(host, 'openclaw.mjs'),
      'plugins',
      'inspect',
      'xmpp',
      '--runtime',
      '--json',
    ],
    options
  );
  const report = JSON.parse(inspected.stdout);
  assert.equal(report.plugin.id, 'xmpp');
  assert.equal(report.plugin.status, 'loaded', JSON.stringify(report));
  assert.equal(report.plugin.imported, true);
  assert.deepEqual(report.plugin.channelIds, ['xmpp']);
  assert.deepEqual(
    report.diagnostics.filter((item) => item.level === 'error'),
    []
  );
  assert.ok(!inspected.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'));
  if (version === '2026.8.2') {
    assert.match(inspected.stderr, /XMPP_FIXTURE_LEGACY_LOCK_REDIRECTS=[1-9]\d*/);
  }
  console.log(
    JSON.stringify({
      runtimeInspection: {
        sdk: version,
        status: report.plugin.status,
        imported: report.plugin.imported,
        channelIds: report.plugin.channelIds,
        builtWithOpenClawVersion: report.plugin.builtWithOpenClawVersion,
      },
    })
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
