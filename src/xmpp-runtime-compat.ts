import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { XMPP_RUNTIME_IMPORTS } from './xmpp-runtime-imports.js';

export const VALIDATED_XMPP_VERSION = '0.14.0';

export interface XmppRuntimeDiagnostic {
  package: string;
  version: string | null;
  status: 'validated' | 'unsupported' | 'unverifiable';
}

interface ResolvedPackage {
  packageJson: URL;
  metadata: unknown;
  matchesResolution: boolean;
}

// Injection is restricted to inspection, never the production assertion/cache.
export type XmppRuntimeResolver = (specifier: string, importer: URL) => ResolvedPackage;

/** Resolve exactly where the reviewed upstream source imports, independent of cwd. */
const resolveRuntimePackage: XmppRuntimeResolver = (specifier, importer) => {
  const require = createRequire(realpathSync(fileURLToPath(importer)));
  const name = specifier.split('/').slice(0, 2).join('/');
  const packageJson = pathToFileURL(require.resolve(`${name}/package.json`));
  const metadata: unknown = JSON.parse(readFileSync(packageJson, 'utf8'));

  // 0.14.0 has no exports map: CJS resolution and ESM resolution select the
  // same explicit index.js/subpath. Fail closed on conditional exports rather
  // than accidentally inspecting a different "require" implementation.
  if (
    !isMetadata(metadata) ||
    metadata.exports !== undefined ||
    metadata.type !== 'module' ||
    metadata.main !== 'index.js'
  ) {
    return { packageJson, metadata, matchesResolution: false };
  }
  const subpath = specifier === name ? 'index.js' : specifier.slice(name.length + 1);
  const expected = realpathSync(fileURLToPath(new URL(subpath, packageJson)));
  return {
    packageJson,
    metadata,
    matchesResolution: realpathSync(require.resolve(specifier)) === expected,
  };
};

function isMetadata(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inspect every reachable copy, including copies reached only from a deep import. */
export function inspectXmppRuntime(
  resolve: XmppRuntimeResolver = resolveRuntimePackage,
  importer: URL = new URL(import.meta.url)
): XmppRuntimeDiagnostic[] {
  // The reviewed map follows Node's default realpath semantics. Preserve-mode
  // symlinks can change dependency ancestry and must not silently bypass it.
  if (
    process.execArgv.some((arg) => /^--preserve-symlinks(?:-main)?(?:=|$)/.test(arg)) ||
    /(?:^|[\s"'])--preserve-symlinks(?:-main)?(?:[\s"'=]|$)/.test(process.env.NODE_OPTIONS ?? '')
  ) {
    return [{ package: '@xmpp/client', version: null, status: 'unverifiable' }];
  }
  const diagnostics: XmppRuntimeDiagnostic[] = [];
  const visited = new Set<string>();

  function visit(specifier: string, importer: URL): void {
    const name = specifier.split('/').slice(0, 2).join('/');
    let resolved: ResolvedPackage;
    try {
      resolved = resolve(specifier, importer);
    } catch {
      diagnostics.push({ package: name, version: null, status: 'unverifiable' });
      return;
    }
    // Resolve/check each edge before deduplication; caller.js and callee.js
    // must both agree with their metadata even when they share a package root.
    const identity = resolved.packageJson.href;
    const { metadata } = resolved;
    if (
      !isMetadata(metadata) ||
      metadata.name !== name ||
      typeof metadata.version !== 'string' ||
      !/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,80})?(?:\+[0-9A-Za-z.-]{1,80})?$/.test(
        metadata.version
      ) ||
      !Object.hasOwn(XMPP_RUNTIME_IMPORTS, name)
    ) {
      diagnostics.push({ package: name, version: null, status: 'unverifiable' });
      return;
    }
    if (!resolved.matchesResolution && metadata.version === VALIDATED_XMPP_VERSION) {
      diagnostics.push({ package: name, version: null, status: 'unverifiable' });
      return;
    }
    if (visited.has(identity)) {
      return;
    }
    visited.add(identity);
    const status = metadata.version === VALIDATED_XMPP_VERSION ? 'validated' : 'unsupported';
    diagnostics.push({ package: name, version: metadata.version, status });
    // Only the validated version has a reviewed import map. Never traverse
    // paths/dependencies supplied by unvalidated or malformed metadata.
    if (status !== 'validated') {
      return;
    }
    for (const [source, dependencies] of Object.entries(XMPP_RUNTIME_IMPORTS[name])) {
      for (const dependency of dependencies) {
        visit(dependency, new URL(source, resolved.packageJson));
      }
    }
  }

  visit('@xmpp/client', importer);
  return diagnostics;
}

/** All public guard errors omit paths, original exceptions and arbitrary metadata. */
export function requireCompatibleXmppRuntime(diagnostics: readonly XmppRuntimeDiagnostic[]): void {
  const failure = diagnostics.find(({ status }) => status !== 'validated');
  if (!failure && diagnostics.length > 0) {
    return;
  }
  const name =
    failure && Object.hasOwn(XMPP_RUNTIME_IMPORTS, failure.package)
      ? failure.package
      : '@xmpp/client';
  const version = failure?.version;
  const label =
    version &&
    /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,80})?(?:\+[0-9A-Za-z.-]{1,80})?$/.test(version)
      ? version
      : 'unverifiable metadata or module layout';
  throw new Error(
    `Unsupported xmpp.js runtime: validated @xmpp/client family is ${VALIDATED_XMPP_VERSION}; ` +
      `resolved ${name} ${label}. Install the validated family and remove conflicting overrides, ` +
      'or revalidate before upgrading.'
  );
}

let validated = false;

/** Once per module instance, before registration, client creation or adaptation. */
export function assertXmppRuntimeCompatible(): void {
  if (validated) {
    return;
  }
  requireCompatibleXmppRuntime(inspectXmppRuntime());
  validated = true;
}
