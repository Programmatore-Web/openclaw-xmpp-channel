import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('ships a reachable, strictly typed public declaration graph', async () => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const temporary = mkdtempSync(join(tmpdir(), 'xmpp-packed-types-'));
  const consumer = join(temporary, 'consumer.ts');
  const packageRoot = join(temporary, 'node_modules', '@openclaw', 'xmpp');
  const env = {
    ...process.env,
    npm_config_offline: 'true',
    npm_config_cache: join(temporary, 'npm-cache'),
    npm_config_update_notifier: 'false',
  };

  try {
    // Use the normal clean build and actual npm pack rules. Nothing from src is
    // copied into the consumer; installed dependencies are reused without I/O
    // to the registry, and all generated consumer files are disposable.
    await exec('npm', ['run', 'build'], { cwd: repository, env });
    const [pack] = JSON.parse(
      (
        await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], {
          cwd: repository,
          env,
          encoding: 'utf8',
        })
      ).stdout
    ) as Array<{ filename: string; files: Array<{ path: string }> }>;
    expect(
      pack.files.filter(
        ({ path }) =>
          !['LICENSE', 'README.md', 'openclaw.plugin.json', 'package.json'].includes(path) &&
          !path.startsWith('dist/')
      )
    ).toEqual([]);

    mkdirSync(packageRoot, { recursive: true });
    await exec('tar', [
      '-xzf',
      join(temporary, pack.filename),
      '--strip-components=1',
      '-C',
      packageRoot,
    ]);
    for (const dependency of ['@types', '@xmpp', 'openclaw', 'zod']) {
      symlinkSync(
        join(repository, 'node_modules', dependency),
        join(temporary, 'node_modules', dependency),
        'dir'
      );
    }
    writeFileSync(join(temporary, 'package.json'), '{"private":true,"type":"module"}');
    writeFileSync(
      consumer,
      readFileSync(new URL('./fixtures/packed-consumer.ts', import.meta.url))
    );

    const options: ts.CompilerOptions = {
      strict: true,
      skipLibCheck: false,
      noUncheckedSideEffectImports: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ['node'],
      typeRoots: [join(temporary, 'node_modules', '@types')],
    };
    const entry = join(packageRoot, 'dist', 'index.d.ts');
    expect(
      ts.resolveModuleName('@openclaw/xmpp', consumer, options, ts.sys).resolvedModule
        ?.resolvedFileName
    ).toBe(entry);

    function check(rootNames: string[]): void {
      const program = ts.createProgram(rootNames, options);
      expect(program.getSourceFile(entry)).toBeDefined();
      expect(
        program
          .getSourceFiles()
          .filter(({ fileName }) => fileName.startsWith(join(repository, 'src') + sep))
      ).toEqual([]);

      // Resolve the real OpenClaw declarations, but check diagnostics only for
      // this package and its consumer. Upstream SDK errors must not hide plugin
      // errors; skipLibCheck stays false and no external types are stubbed.
      const owned = program
        .getSourceFiles()
        .filter(({ fileName }) => fileName === consumer || fileName.startsWith(packageRoot + sep));
      const diagnostics = [
        ...program.getOptionsDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...owned.flatMap((source) => [
          ...program.getSyntacticDiagnostics(source),
          ...program.getSemanticDiagnostics(source),
        ]),
      ];
      expect(
        ts.formatDiagnostics(diagnostics, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => temporary,
          getNewLine: () => '\n',
        })
      ).toBe('');
    }

    // This first program must start ONLY at the normal package import. Adding
    // all declarations up front would conceal a shipped but unreachable shim.
    check([consumer]);
    // Also check emitted declarations outside the root's transitive graph.
    check([
      consumer,
      ...pack.files
        .filter(({ path }) => path.endsWith('.d.ts'))
        .map(({ path }) => join(packageRoot, path)),
    ]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 120_000);
