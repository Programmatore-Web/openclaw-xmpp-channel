// Explicit integration gate: uses the public registry/cache and disposable consumers.
// No repository lockfile, dependency symlinks, dev tools, or global config mutations.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'xmpp-packed-runtime-'));
const env = { ...process.env, npm_config_update_notifier: 'false' };
const npm = async (cwd, args) =>
  (await exec('npm', args, { cwd, env, timeout: 300_000, maxBuffer: 20_000_000 })).stdout;
const install = (cwd, args = []) =>
  npm(cwd, ['install', ...args, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']);

const probe = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const loaded = [];
const resolved = [];
const hooks = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.includes('/@xmpp/') && url.endsWith('.js')) loaded.push(url);
  return result;
}, resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (specifier.startsWith('@xmpp/') && !specifier.endsWith('/package.json')) {
    resolved.push({ specifier, parent: context.parentURL, url: result.url });
  }
  return result;
}});
const entry = import.meta.resolve('@openclaw/xmpp');
// OpenClaw's native path loads the absolute extension synchronously.
const required = createRequire(import.meta.url)(fileURLToPath(entry));
const { default: plugin } = await import('@openclaw/xmpp');
assert.equal(required.default, plugin);
const compat = await import(new URL('./src/xmpp-runtime-compat.js', entry));
const diagnostics = compat.inspectXmppRuntime();
let registered = false;
try {
  plugin.register({runtime:{}, registerChannel(){registered=true;}});
  assert.equal(process.argv[2], 'pass');
  assert.equal(registered, true);
  const { client, xml } = await import(new URL('./src/xmpp.js', entry));
  const entity = client({service:'xmpp://example.com:5222', domain:'example.com'});
  entity.reconnect.stop();
  assert.equal(xml('presence').name,'presence');
  assert.equal(new Set(diagnostics.map(d=>d.package)).size,28);
  assert.ok(diagnostics.every(d=>d.status==='validated' && d.version==='0.14.0'));
  for (const {specifier,parent,url} of [...resolved]) {
    const require = createRequire(parent);
    const name = specifier.split('/').slice(0,2).join('/');
    const metadata = JSON.parse(readFileSync(require.resolve(name+'/package.json'),'utf8'));
    assert.equal(metadata.version, '0.14.0');
    assert.ok(diagnostics.some(d=>d.package===name && d.version===metadata.version));
    assert.equal(url,pathToFileURL(require.resolve(specifier)).href);
  }
  assert.ok(loaded.length>25);
  console.log(JSON.stringify({registered,diagnostics,observedImports:loaded.length}));
} catch(error) {
  if (process.argv[2] === 'pass') throw error;
  assert.equal(registered,false);
  assert.equal(loaded.length,0, 'native xmpp graph must not load on mismatch');
  assert.match(error.message,/Unsupported xmpp.js runtime/);
  assert.match(error.message,/revalidate before upgrading/);
  assert.ok(!error.message.includes(process.cwd()));
  assert.ok(!error.message.includes('file:'));
  console.log(JSON.stringify({registered,error:error.message,observedImports:loaded.length}));
}
hooks.deregister();
`;

try {
  await npm(repository, ['run', 'build']);
  const [pack] = JSON.parse(
    await npm(repository, ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary])
  );
  const tarball = join(temporary, pack.filename);
  assert.equal(
    pack.files.some(({ path }) => /(?:package-lock|npm-shrinkwrap)\.json$/.test(path)),
    false
  );
  assert.deepEqual(pack.bundled, []);

  for (const [name, extras, expected] of [
    ['clean', {}, 'pass'],
    [
      'compatible',
      { dependencies: { '@xmpp/client': '0.14.0', '@xmpp/connection': '0.14.0' } },
      'pass',
    ],
    [
      'conflicting',
      { dependencies: { '@xmpp/client': '0.13.6', '@xmpp/connection': '0.13.1' } },
      'pass',
    ],
    ['override', { overrides: { '@xmpp/connection': '0.13.1' } }, 'fail'],
  ]) {
    await test(`packed consumer: ${name}`, async () => {
      const cwd = join(temporary, name);
      await mkdir(cwd);
      try {
        await writeFile(
          join(cwd, 'package.json'),
          JSON.stringify({
            name: 'disposable-xmpp-consumer',
            version: '1.0.0',
            private: true,
            type: 'module',
            ...extras,
            dependencies: { openclaw: '2026.8.2', ...extras.dependencies },
          })
        );
        // B consumers already own their XMPP dependencies before plugin installation.
        if (extras.dependencies) await install(cwd);
        await install(cwd, [tarball]);
        const tree = JSON.parse(await npm(cwd, ['ls', '--all', '--json']));
        assert.equal(tree.dependencies.openclaw.version, '2026.8.2');
        const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
        const hosts = Object.keys(lock.packages).filter((name) =>
          /(?:^|\/)node_modules\/openclaw$/.test(name)
        );
        assert.deepEqual(hosts, ['node_modules/openclaw']);
        assert.equal(
          Object.values(lock.packages).some((p) => p.dev === true),
          false
        );
        assert.equal(
          Object.keys(lock.packages).some((p) => p.endsWith('node_modules/vitest')),
          false
        );
        await writeFile(join(cwd, 'probe.mjs'), probe);
        const result = await exec(process.execPath, ['probe.mjs', expected], {
          cwd,
          env,
          maxBuffer: 2_000_000,
        });
        console.log(name, result.stdout.trim());
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
