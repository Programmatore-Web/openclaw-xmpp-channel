import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectXmppRuntime,
  requireCompatibleXmppRuntime,
  VALIDATED_XMPP_VERSION,
  type XmppRuntimeResolver,
} from '../src/xmpp-runtime-compat.js';
import { XMPP_RUNTIME_IMPORTS } from '../src/xmpp-runtime-imports.js';

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
);

function resolver(
  change?: (name: string, metadata: Record<string, unknown>) => unknown
): XmppRuntimeResolver {
  return (specifier) => {
    const name = specifier.split('/').slice(0, 2).join('/');
    const metadata = { name, version: VALIDATED_XMPP_VERSION };
    return {
      packageJson: new URL(`file:///private/fixture/node_modules/${name}/package.json`),
      metadata: change ? change(name, metadata) : metadata,
      matchesResolution: true,
    };
  };
}

// Entirely authored disposable fixtures, never copies/patches of real node_modules.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xmpp-runtime-compat-'));
  temporary.push(root);
  const put = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const packageRoot = (name: string) => join(root, 'node_modules', name);
  const metadata = (name: string, version = '0.14.0') => ({
    name,
    version,
    type: 'module',
    main: 'index.js',
  });
  const addPackage = (directory: string, name: string, version = '0.14.0') => {
    put(join(directory, 'package.json'), JSON.stringify(metadata(name, version)));
    put(join(directory, 'index.js'), `export default ${JSON.stringify(version)};`);
  };
  for (const [name, sites] of Object.entries(XMPP_RUNTIME_IMPORTS)) {
    addPackage(packageRoot(name), name);
    for (const [source, dependencies] of Object.entries(sites)) {
      put(join(packageRoot(name), source), 'export {};');
      for (const dependency of dependencies) {
        const parts = dependency.split('/');
        if (parts.length > 2)
          put(join(packageRoot(parts.slice(0, 2).join('/')), ...parts.slice(2)), 'export {};');
      }
    }
  }
  const importer = join(root, 'plugin', 'entry.js');
  put(importer, 'export {};');
  const inspect = () => inspectXmppRuntime(undefined, pathToFileURL(importer));
  return { root, packageRoot, put, metadata, addPackage, importer, inspect };
}

function publicError(diagnostics: ReturnType<typeof inspectXmppRuntime>): string {
  try {
    requireCompatibleXmppRuntime(diagnostics);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected closed guard');
}

describe('xmpp.js exact runtime contract', () => {
  it.each(['--preserve-symlinks', '--preserve-symlinks-main'])(
    'rejects uncharacterized %s resolution',
    (flag) => {
      vi.stubEnv('NODE_OPTIONS', flag);
      try {
        expect(publicError(inspectXmppRuntime())).toContain(
          'unverifiable metadata or module layout'
        );
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it('accepts the installed family and every validated exact version', () => {
    const installed = inspectXmppRuntime();
    expect(installed).toHaveLength(28);
    expect(installed.map((d) => d.package).sort()).toEqual(
      Object.keys(XMPP_RUNTIME_IMPORTS).sort()
    );
    expect(installed.every((d) => d.version === '0.14.0' && d.status === 'validated')).toBe(true);
    expect(() => requireCompatibleXmppRuntime(installed)).not.toThrow();
    expect(() => requireCompatibleXmppRuntime(inspectXmppRuntime(resolver()))).not.toThrow();
  });

  it.each(['@xmpp/client', '@xmpp/connection', '@xmpp/iq', '@xmpp/starttls', '@xmpp/events'])(
    'rejects an unvalidated %s implementation',
    (name) => {
      const result = inspectXmppRuntime(
        resolver((pkg, metadata) => (pkg === name ? { ...metadata, version: '0.14.1' } : metadata))
      );
      expect(result).toContainEqual({ package: name, version: '0.14.1', status: 'unsupported' });
      expect(publicError(result)).toContain(`resolved ${name} 0.14.1`);
    }
  );

  it.each([
    null,
    [],
    { name: '@xmpp/connection' },
    { name: 'wrong', version: '0.14.0' },
    { name: '@xmpp/connection', version: '/private/secret/token' },
  ])('fails closed on malformed metadata %j', (bad) => {
    const result = inspectXmppRuntime(
      resolver((name, metadata) => (name === '@xmpp/connection' ? bad : metadata))
    );
    expect(publicError(result)).toContain('unverifiable metadata');
    expect(publicError(result)).not.toMatch(/private|secret|token/);
  });

  it('contains unreadable metadata errors and gives an actionable path-free error', () => {
    const good = resolver();
    const result = inspectXmppRuntime((specifier, importer) => {
      if (specifier === '@xmpp/connection') throw new Error('EACCES /private/host/token');
      return good(specifier, importer);
    });
    const error = publicError(result);
    expect(error).toContain('validated @xmpp/client family is 0.14.0');
    expect(error).toContain('revalidate before upgrading');
    expect(error).not.toMatch(/EACCES|private|host|token|file:/);
    expect(() => requireCompatibleXmppRuntime([])).toThrow('Unsupported xmpp.js runtime');
  });

  it('resolves hoisted fixtures independently of cwd', () => {
    const f = fixture();
    expect(() => requireCompatibleXmppRuntime(f.inspect())).not.toThrow();
  });

  it('finds the mismatched copy actually imported from client-core/lib, despite a valid root copy', async () => {
    const f = fixture();
    const source = join(f.packageRoot('@xmpp/client-core'), 'lib/Client.js');
    const nested = join(dirname(source), 'node_modules/@xmpp/connection');
    f.addPackage(nested, '@xmpp/connection', '0.14.1');
    f.put(source, "import version from '@xmpp/connection'; console.log(version);");
    expect(
      (
        await promisify(execFile)(process.execPath, [source], { cwd: tmpdir(), encoding: 'utf8' })
      ).stdout.trim()
    ).toBe('0.14.1');
    expect(
      JSON.parse(readFileSync(join(f.packageRoot('@xmpp/connection'), 'package.json'), 'utf8'))
        .version
    ).toBe('0.14.0');
    const result = f.inspect();
    expect(result).toContainEqual({
      package: '@xmpp/connection',
      version: '0.14.1',
      status: 'unsupported',
    });
    expect(result).toContainEqual({
      package: '@xmpp/connection',
      version: '0.14.0',
      status: 'validated',
    });
    expect(publicError(result)).toContain('@xmpp/connection 0.14.1');
  });

  it('follows real package locations in a pnpm-style symlink store', () => {
    const f = fixture();
    const physical = join(f.root, '.pnpm/client/node_modules/@xmpp/client');
    f.addPackage(physical, '@xmpp/client');
    f.put(join(physical, 'index.js'), 'export {};');
    rmSync(f.packageRoot('@xmpp/client'), { recursive: true });
    symlinkSync(physical, f.packageRoot('@xmpp/client'), 'dir');
    for (const name of Object.keys(XMPP_RUNTIME_IMPORTS).filter(
      (name) => name !== '@xmpp/client'
    )) {
      symlinkSync(f.packageRoot(name), join(dirname(physical), name.split('/')[1]), 'dir');
    }
    const nested = join(f.root, '.pnpm/client/node_modules/@xmpp/starttls');
    rmSync(nested);
    f.addPackage(nested, '@xmpp/starttls', '0.14.1');
    expect(publicError(f.inspect())).toContain('@xmpp/starttls 0.14.1');
  });

  it.each(['missing', 'invalid-json', 'exports', 'main'])(
    'rejects a %s metadata/layout fixture',
    (kind) => {
      const f = fixture();
      const file = join(f.packageRoot('@xmpp/connection'), 'package.json');
      if (kind === 'missing') rmSync(file);
      if (kind === 'invalid-json') writeFileSync(file, '{ /private/secret');
      if (kind === 'exports')
        writeFileSync(
          file,
          JSON.stringify({
            ...f.metadata('@xmpp/connection'),
            exports: { '.': { import: './index.js', require: './other.js' } },
          })
        );
      if (kind === 'main')
        writeFileSync(
          file,
          JSON.stringify({ ...f.metadata('@xmpp/connection'), main: './other.js' })
        );
      const error = publicError(f.inspect());
      expect(error).toContain('@xmpp/connection unverifiable');
      expect(error).not.toContain(f.root);
      expect(error).not.toMatch(/private|secret/);
    }
  );
});
