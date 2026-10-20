# OpenClaw 2026.10.5 compatibility review

Date: 2026-10-20. **Final refinement checkpoint; not a release.**
OpenClaw **2026.10.5** is the priority target. The existing small SDK adapter
is retained without adding legacy-host complexity.

## Current checkpoint: preflight and scope

The clean local/fetched branch `fix/xmpp-openclaw-2026-10-5-compat` started at
`023455349af7430650e819b1a19a57abf1a44a8b`; origin/main remained
`beb003f8bb7bfa6ce4310cfa62f923f35d8819fc`. Repository and origin matched the
public project. Node **24.22.0**, npm **11.19.1**, Linux, user `node`.
Fetch did not merge or rebase anything.

Changed files in this refinement:

- `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
  `XMPP-RUNTIME-COMPATIBILITY.md`, and this report.
- `scripts/test-default-account-runtime.mjs` and
  `scripts/test-openclaw-2026-10-5-runtime.mjs`.
- `test/accounts.test.ts`, `test/actions.test.ts`, `test/channel-contracts.test.ts`,
  `test/config-schema.test.ts`, `test/inbound-delivery.test.ts`,
  `test/password-secrets.test.ts`.
- `package-lock.json`.

Application code, SDK adapter, runtime schema, xmpp.js guard, `@xmpp/client@0.14.0`,
Zod 4.6.5, package version 4.2.0, manifest and Dev Container are unchanged.
The current changes and the aggregate diff against origin/main were reviewed.

## Public neutrality

All **98 tracked files** were scanned before editing, including hidden
configuration, manifests, scripts, tests and documentation. Candidates were
reviewed in context. The deployment-specific account label is now `secondary`,
including object keys, JIDs, owners, bindings, expectations and fixture output.
`main` remains for the OpenClaw convention. An unrelated infrastructure repository
reference and one-off local validation-directory names were removed from this report.

The eight edited test/script files were compared with the baseline after only
identifier replacement and formatting: no assertion, timeout, skip, account order
or application behavior changed. The final scan found no remaining identified
deployment-specific labels, real credentials, operational hosts/IPs or personal
paths in current tracked content.

Intentionally retained public/generic material:

- This public repository's clone, issue and homepage URLs.
- Upstream registry, protocol, advisory and package-funding metadata; the contact
  address in an upstream package deprecation notice is not an operator credential.
- Reserved example domains, conventional fictional example users, `localhost`
  and loopback used by local tests.
- Standard container paths `/home/node/.codex` and
  `/workspaces/openclaw-xmpp-channel`, with the workspace source supplied by
  `${localWorkspaceFolder}`; no author's host filesystem path is embedded.
- Names of public XMPP server software in product descriptions.

Git history was not rewritten. Operational systems, other repositories and real
OpenClaw configuration, accounts, credentials or sessions were not accessed.

## Compatibility statements and build provenance

README and CONTRIBUTING no longer present the whole OpenClaw 2026 series as
validated. Exact **2026.8.2, 2026.9.9 and 2026.10.5** passed the previous complete
SDK/plugin matrix. This refinement repeats the repository gates and priority-host
checks shown below; it does not extrapolate to **2026.10.1**, other releases,
other Node platforms or field operation.

No package metadata changed:

| Metadata | Retained value | Reason |
| --- | --- | --- |
| `peerDependencies.openclaw` | `^2026.8.2` | Resolution constraint, not proof that every matching release was tested |
| `openclaw.compat.pluginApi` | `>=2026.8.2` | No demonstrated need to change the API declaration in this refinement |
| `openclaw.build.openclawVersion` | `2026.8.2` | The repository lock, compiler resolution and distributed tarball build actually use this SDK |

The real 2026.10.5 loader reads the build field into `builtWithOpenClawVersion`,
reports it in inspection and uses it in SDK-import diagnostic hints. It is not
the declaration of the newest tested host or an exact required runtime version.
The packed plugin loads on 2026.10.5 while reporting its actual 2026.8.2 build
provenance. No cosmetic metadata update or version bump is proposed.

## Targeted dependency assessment

Before the change, `npm audit --omit=dev --omit=peer` returned **FAIL** with one
high vulnerability entry for the root `brace-expansion@5.0.9`.
`npm ls brace-expansion minimatch --all --json` and `npm explain brace-expansion
--json` established these paths:

- Peer host `openclaw@2026.8.2 -> minimatch@10.2.6 -> brace-expansion@5.0.9`.
- Development tooling `@typescript-eslint/typescript-estree@8.69.0 ->
  minimatch@10.2.6 -> brace-expansion@5.0.9`.

It is not a direct XMPP dependency. The shared root lock entry has neither
`dev` nor `peer` set, so it appears in the filtered audit. In contrast,
`npm ls brace-expansion --omit=dev --omit=peer --all --json` shows no retained
dependency path (npm exits 1 for that empty query, not for an invalid installation).

Only that root artifact is updated to **5.0.12**, using registry version,
tarball URL and SHA-512 integrity. It satisfies minimatch's existing `^5.0.8`
range and retains the same `balanced-match: ^4.0.2` dependency and Node engine.
The lockfile diff changes exactly **three fields**; no other package record,
manifest dependency or override changes. `npm ci --ignore-scripts` verifies
the artifact and reproducible installation.

Upstream advisories are
[GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr),
[GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) and
[GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p).
Version 5.0.12 is outside all three affected 5.x ranges.

**Filtered audit after the patch: PASS, zero vulnerabilities.**

**Separate full audit: FAIL**, nine pre-existing development/peer entries
(two moderate, six high, one critical). These include brace-expansion 1.1.18
under ESLint and 2.1.4 under glob, plus the peer graph's
`proxy-addr@2.0.7` critical entry. Other reported entries are
`@modelcontextprotocol/sdk`, `fast-uri`, `hono`, `ip-address`, `openclaw`,
`source-map-js` and `undici`. Their versions are unchanged. They require a separate
dependency review; this checkpoint does not claim a clean full dependency audit.
No `npm audit fix`, unrelated upgrade or permanent override was applied.
The repository lockfile is not shipped in the plugin tarball, so this targeted
lock correction does not force dependency versions in consumers' host installs.

## Current validation results

| Gate | Result and scope |
| --- | --- |
| `npm ci --ignore-scripts` | PASS |
| `npm run build` | PASS, locked SDK 2026.8.2 |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm test -- --run --maxWorkers=1` | PASS, 956/956 tests in 34 files |
| `npm pack --dry-run` | PASS |
| `npm run test:packed-runtime` | PASS, 4/4 real consumers; incompatible override rejected |
| `npm run test:secret-runtime` | PASS, 9/9, repository SDK 2026.8.2 |
| `npm run test:default-account-runtime` | PASS, 3/3, repository SDK 2026.8.2 |
| `node scripts/test-d3-runtime.mjs` | PASS, 8/8, repository SDK 2026.8.2 |
| `npm audit --omit=dev --omit=peer` | PASS, zero vulnerabilities |
| Real 2026.10.5 source build / complete suite | PASS; 956/956 tests in 34 files, including strict packed declaration checks |
| Real 2026.10.5 installed tarball probe / CLI registration | PASS, fresh consumer from the documented Bash sequence |
| `git diff --check` | PASS |

Current packed artifact: **137 files, 124,673 bytes**; integrity:

```text
sha512-5hUOwaZjWRWQJjypEwA01ktWMdhdr/5YN6itYHTapZabOKztPzoxO5k/cWwEXwj6MbbYVkO8/o0bqCSJvS3niw==
```

The exact core, SDK factory path, plugin origin, Zod 4.6.5 and all 28 xmpp.js
components at 0.14.0 are asserted in the isolated consumer. Runtime checks use
`main`/`secondary` and preserve start/end, abort/deactivate, teardown, fail-closed
schema/defaults, routing and SecretRef ownership/inheritance checks.

The complete suites use **one worker**. Earlier concurrent runs hit the strict
transport child's wall-clock deadline; default concurrency has not been
revalidated on this final source. No timeout, assertion or test count was reduced.

**NON ESEGUITO in this refinement:** the separate full 2026.9.9 matrix and the
native mixed-Zod 2026.8.2 consumer matrix (their previous results remain historical
evidence); 2026.10.1; older private-host SecretRef/default-account/D3 harnesses on
2026.10.5; live XMPP/production tests; other Node versions/platforms. Existing host
allowlists were not widened. The real public packed probe supplies the current
2026.10.5 loading and registration evidence.

## Reproducing the checks

Run the repository commands in the table sequentially after the clean install.
In particular, do not overlap the packed-types test or packed-runtime harness
with other commands that rebuild `dist`. Tests use their existing fixture
isolation; validation also supplies temporary `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`,
`OPENCLAW_CONFIG_PATH` and XDG directories, and a temporary npm cache.

For the priority-host probe, create a disposable consumer under the temporary
directory and install **exact** `openclaw@2026.10.5` plus the local tarball with
`--ignore-scripts --omit=dev --save-exact`. The consumer must contain real npm
installations, not symlinks to this repository.

The public CLI also needs its package lifecycle prepared. Inspect the installed
host's `scripts/preinstall-package-manager-warning.mjs` and
`scripts/postinstall-bundled-plugins.mjs`, then run those exact scripts with
OpenClaw/XDG paths inside the temporary consumer and Node permissions allowing
reads in the consumer and writes only in its OpenClaw package. Subprocesses stay
denied; optional native-probe warnings under that restriction are documented
below. Do not run an operational setup command or start a Gateway.

The following Bash sequence starts from the repository after a successful build.
The original 4.2.0 sequence was executed successfully against a new consumer;
its installed tarball integrity matched the historical artifact above. The tarball
path below now comes from npm pack metadata so it follows the package version.
The results above remain evidence for the 4.2.0 checkpoint.
Review the two installed host scripts before the lifecycle loop.

```bash
set -e
validation_dir="$(mktemp -d)"
consumer_dir="$validation_dir/consumer"
mkdir "$consumer_dir" "$validation_dir/artifact"
fixture_env() {
  env -i PATH="$PATH" TMPDIR="$validation_dir" \
    OPENCLAW_HOME="$consumer_dir/.state" \
    OPENCLAW_STATE_DIR="$consumer_dir/.state" \
    OPENCLAW_CONFIG_PATH="$consumer_dir/.state/unused.json" \
    OPENCLAW_AUTH_STORE_READONLY=1 OPENCLAW_NO_RESPAWN=1 \
    XDG_CONFIG_HOME="$consumer_dir/.state" \
    XDG_DATA_HOME="$consumer_dir/.state" \
    XDG_CACHE_HOME="$consumer_dir/.state" \
    npm_config_cache="$validation_dir/npm-cache" "$@"
}
fixture_env npm pack --json --ignore-scripts --pack-destination "$validation_dir/artifact" \
  > "$validation_dir/pack.json"
tarball_name="$(fixture_env node -p 'require(process.argv[1])[0].filename' "$validation_dir/pack.json")"
fixture_env npm install --prefix "$consumer_dir" --ignore-scripts --omit=dev \
  --save-exact openclaw@2026.10.5 \
  "$validation_dir/artifact/$tarball_name"
host_dir="$consumer_dir/node_modules/openclaw"
(
  cd "$consumer_dir"
  for hook in preinstall-package-manager-warning.mjs postinstall-bundled-plugins.mjs
  do
    fixture_env node --permission --allow-fs-read="$consumer_dir" \
      --allow-fs-write="$host_dir" "$host_dir/scripts/$hook" || exit
  done
)
fixture_env node scripts/test-openclaw-2026-10-5-runtime.mjs "$consumer_dir"
```

## Historical evidence: approved second checkpoint

The following sections describe the previously approved baseline, not a second
execution of its entire matrix in this refinement. Fixture labels are normalized
for public documentation. The old audit failure is superseded by the current
filtered result above; the adapter/Zod analysis and isolation contracts remain
useful evidence.

Date: 2026-10-20. **WIP; coordinator review required before distribution.**
This iteration bridges the public lifecycle SDK and removes the cross-version
Zod type boundary. It does not change release metadata or declare support for
untested OpenClaw versions. The first checkpoint exposed build failures and a
static-import regression; the fixes and validation are documented below.

### Preflight and scope

- Repository/origin: `Programmatore-Web/openclaw-xmpp-channel`.
- Existing branch: `fix/xmpp-openclaw-2026-10-5-compat`.
- Starting HEAD and fetched origin branch:
  `ef47a7134a8c48fe55db6f52a7e73443eaf0ff2b`.
- Fetched origin/main: `beb003f8bb7bfa6ce4310cfa62f923f35d8819fc`.
- Initially clean, including untracked files; no merge, rebase, reset or stash.
- Node `v24.22.0`, npm `11.19.1`, user `node`, UID/GID `1000`.
- Validation files, caches and consumer installations use disposable temporary
  directories, separate from operational OpenClaw configuration.

Changed files: `src/sdk-run-state.ts`, `src/monitor.ts`, `src/state.ts`,
`src/config-schema.ts`, `package.json`, `package-lock.json`,
`test/sdk-run-state.test.ts`, `test/inbound-security.test.ts`,
`test/packed-types.test.ts`, `test/setup.ts`,
`scripts/test-openclaw-2026-10-5-runtime.mjs`, and this report.

No change to the Dev Container, README, application version `4.2.0`,
`peerDependencies.openclaw`, `openclaw.compat.pluginApi`,
`openclaw.build.openclawVersion`, or `openclaw.plugin.json`.
The xmpp.js guard and `@xmpp/client@0.14.0` are unchanged.

### SDK adapter

The adapter imports the namespace of public `channel-outbound`, which exists on
all three tested hosts. It exports the actual `createRunStateMachine` function
when present. Only an absent property selects the old public
`channel-lifecycle`, loaded synchronously using `createRequire(import.meta.url)`.
An invalid export, module initialization failure, missing dependency or other
load error propagates. There is no catch-and-fallback, top-level await, private
core import, state-machine implementation copy or factory wrapper.

The local type describes only the shared parameters (`setStatus`, `abortSignal`,
`heartbeatMs`, `now`) and methods (`isActive`, `onRunStart`, `onRunEnd`,
`deactivate`). The dynamic boundary checks that the export is a function.
Bidirectional TypeScript assignments against the actual selected SDK declaration
verify the signature; packed runtime probes assert function identity.
The monitor, lifecycle state type and inbound security test use this adapter.

Keeping the common module in the ESM graph matters for startup cost. An initial
all-`require` candidate took about 12 seconds to initialize the old outbound graph
in a local measurement; ESM took about 4 seconds. The legacy-only require preserves
synchronous plugin loading without that unnecessary cost in ESM consumers.

All production SDK subpaths and named imports were checked through real builds,
the installed export maps and packed module loading:
`core`, `channel-outbound`, `channel-contract`, `channel-core`, `channel-policy`,
`secret-input`, `setup`, `runtime`, `channel-secret-basic-runtime`, plus the
conditional `channel-lifecycle`. Factory declarations are checked separately
because the factory is not a static named import. The removed legacy subpath is
explicitly asserted to be unavailable on 2026.10.5.

### Zod experiment and final boundary

Controlled source copies reproduced these results before the package update:

| Experiment | Result |
| --- | --- |
| 2026.10.5 SDK, plugin Zod 4.3.6, original Zod builder | FAIL: TS2345, missing `validate` / `validateAsync` |
| Same source/SDK, plugin Zod 4.6.5 | PASS: build |
| 2026.8.2 SDK with its native Zod 4.4.3, plugin Zod 4.6.5, original builder | FAIL: incompatible Zod internals, including minor-version literal types |
| Same mixed-Zod graph, public JSON builder with plugin runtime validator | PASS: build |

The direct dependency bump alone was therefore insufficient. The final code calls
public `core.buildJsonChannelConfigSchema` with the plugin's JSON schema and its
own Zod `safeParse` validator. JSON conversion keeps `draft-07`, input mode and
the existing treatment of unrepresentable refinements; the runtime validator
retains those refinements, including dynamic `defaultAccount` existence.
Issue fields are preserved and paths normalized to the SDK's string/number
contract. No schema field, default, password transformation or authorization rule
was changed. No cast or compiler-option relaxation was used.

The real-host probe compares the resulting schema, UI hints, successful parse
results and rejection issues with the real SDK's original Zod builder.
It also checks the published manifest schema, root-only defaults, invalid
configuration rejection, main/secondary defaults and bindings, inherited/overridden
SecretRefs, opaque whitespace/environment-like password strings and real SDK
secret assignment ownership.

Both `dependencies.zod` and `overrides.zod` now pin **4.6.5**. The lockfile changes
only the root Zod dependency and the `node_modules/zod` artifact (including its
npm license metadata). No other dependency version changed.

The unit setup's existing mocked core schema constructor was updated to the new
constructor name; it forwards the plugin's actual runtime validator. Cold JSON
schema tests still call the real `channel-config-schema` helper. Real SDK
validation, native loading and registration are tested separately without that
unit mock. No test, assertion, timeout or TypeScript option was removed.

### Real environments and packaging

The repository was reinstalled using `npm ci --ignore-scripts`. Its lock still
resolves OpenClaw 2026.8.2; the root override makes both host and plugin Zod 4.6.5.
This repository installation was not used as evidence for another host version.

Separate npm consumers contain exact OpenClaw **2026.8.2**, **2026.9.9** and
**2026.10.5**, installed with scripts disabled. Version, export paths, resolved
Zod and xmpp.js versions were inspected. The 2026.9.9 build identifier matches
`bcfc88812a35243893585dbeca87ca41b48272ca`.

Source copies use the same TypeScript **5.9.3** and development tools, with only
their SDK resolution directed to the respective real installation. Plugin Zod
is 4.6.5. The native 2026.8.2 SDK independently resolves **4.4.3**; the other two
resolve **4.6.5**. Full tests on the mixed graph check that the root override does
not conceal an installed-consumer regression.

One repository-built tarball is installed by npm in each consumer, without
symlinks to plugin source or repository dependencies. Each consumer lock records
the same local artifact and integrity:

```text
sha512-Md6gOtxDwfQlzTK86s13sgSsNBDrl7tJnaw7cRSpjOpQf69OjDh+latJOi9BAYYOrIT67zAaYThSHk6cZjGpbQ==
```

The package contains **137 files**, including the adapter declarations, and no
tests, scripts, source directory, nested tarball, lockfile or bundled dependencies.
Installed-consumer declaration checks use the existing strict fixture, NodeNext
resolution and `skipLibCheck: false`, first from the public import alone and then
all emitted declarations plus bidirectional factory assignments. As in the
existing packed-types gate, diagnostics are checked for the plugin and consumer;
unrelated upstream declarations are not substituted with stubs.

### Runtime isolation and characterized harnesses

The extended probe retains its target default and accepts only characterized
versions:

```sh
node scripts/test-openclaw-2026-10-5-runtime.mjs /tmp/<consumer> [2026.8.2|2026.9.9|2026.10.5]
```

It verifies a cold native synchronous plugin load before evaluating SDK modules
in the probe, ESM import identity, the packed secret contract, the selected real
factory, concurrent runs, heartbeat, end saturation, abort, explicit deactivation,
pre-aborted account lifecycles and empty owner/client maps. The xmpp.js guard
validates all 28 packages at 0.14.0. Socket connections are forbidden.

Actual `openclaw plugins inspect xmpp --runtime --json` verifies loader/SDK
registration: imported plugin, `status: loaded`, `channelIds: ["xmpp"]`, zero
error diagnostics and no removed-subpath load error. The command does not start
a Gateway. Its fixture config contains only plugin loading policy, no accounts
or credentials.

Official package lifecycle scripts were reviewed and run explicitly in the
temporary installations under Node permissions: reads in the consumer, writes
only in its OpenClaw package, subprocesses denied. The optional fs-safe native
probe on newer hosts reports the subprocess restriction; lifecycle completion
and actual CLI loading succeed independently.

The direct probe uses Node filesystem permissions. CLI inspection needs `fchmod`,
which Node's permission model disallows; it uses an environment allowlist,
temporary OpenClaw/XDG paths, path-based data-I/O guards and blocked sockets.
On exact 2026.8.2, the real SQLite coordinator hardcodes `/tmp` despite TMPDIR.
The CLI preload redirects only the construction of
`/tmp/openclaw-state-locks-<uid>/...` into that probe's temporary directory and
asserts that the redirection was exercised. Real SQLite, locking and SDK
operations remain in use; the filesystem guard is not widened. This is test
instrumentation, not an OS sandbox or a mock plugin registry.

The secret/default-account/D3 characterization allowlists were not widened.
The newer hosts' shared public inspect command, JSON/runtime schema contract and
factory signatures were inspected before extending the separate packed probe.
An initial new secret fixture lacked JIDs and correctly produced no assignments;
it was corrected to configured main/secondary fixtures, retaining and strengthening
the assignment assertions.

### Results at the second checkpoint

| Check on the final source/artifact | 2026.8.2, native host Zod 4.4.3 | 2026.9.9 | 2026.10.5 |
| --- | --- | --- | --- |
| Real source build | PASS | PASS | PASS |
| Complete unit suite | PASS, 956/956, 34 files | PASS, 956/956, 34 files | PASS, 956/956, 34 files |
| Public-import and all-emitted declaration checks on the same installed tarball | PASS, zero owned diagnostics | PASS, zero owned diagnostics | PASS, zero owned diagnostics |
| Cold synchronous load and ESM identity | PASS | PASS | PASS |
| Real CLI loader/SDK registration | PASS | PASS | PASS |
| Selected factory identity and typed common contract | PASS, `channel-lifecycle` | PASS, `channel-lifecycle` | PASS, `channel-outbound` |
| Run start/end, heartbeat, abort, deactivate and cleanup | PASS | PASS | PASS |
| Real schema, main/secondary routing/defaults and SecretRef inheritance | PASS | PASS | PASS |
| Unchanged native xmpp.js runtime guard | PASS, 28 packages | PASS, 28 packages | PASS, 28 packages |

The repository baseline (2026.8.2 with the root Zod override at 4.6.5) also passes
the source build and **956/956 tests in 34 files**. This is all 944 pre-existing
tests plus 12 adapter tests, with no skips.

| Repository / characterization gate | Result and scope |
| --- | --- |
| `npm ci --ignore-scripts` | PASS, final lockfile |
| `npm run build` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm pack --dry-run` | PASS, 137 files; same integrity as the installed artifact |
| `npm run test:packed-runtime` | PASS, 4/4 real 2026.8.2 consumers: clean, compatible, conflicting dependency and deliberately incompatible override rejected by the guard |
| `npm run test:secret-runtime` | PASS, 9/9 on repository 2026.8.2; repeated with the separate native-Zod 2026.8.2 host, 9/9 |
| `npm run test:default-account-runtime` | PASS, 3/3 on 2026.8.2 and 3/3 with the separate 2026.9.9 host |
| `node scripts/test-d3-runtime.mjs` | PASS, 8/8 on 2026.8.2 |
| `npm audit --omit=dev --omit=peer` | FAIL, pre-existing high advisory entry described below |
| `git diff --check` | PASS |

**Earlier FAIL results, resolved or superseded:** the controlled raw-Zod builds
above failed before the JSON boundary. Initial full suites with default workers
and an all-require adapter hit the strict transport child's 10-second wall-clock
deadline; one candidate run also hit the packed-types timeout. A target run before
restoring the original core-constructor unit boundary still recorded 955 PASS /
1 FAIL (transport child timeout). Direct execution of that unchanged child
scenario passed its transport assertions. Final full suites use
`npm test -- --run --maxWorkers=1` and pass on every tested graph. The literal
default-worker command was exercised during investigation, but is not claimed
as a final passing command. No timeouts were extended, assertions removed,
transport implementation changed or tests excluded.

### Audit and limits at the second checkpoint

At that checkpoint, `npm audit --omit=dev --omit=peer` returned **FAIL**: one high vulnerability entry
for the pre-existing **brace-expansion 5.0.9**. Paths in the unchanged graph include
`openclaw@2026.8.2 -> minimatch@10.2.6 -> brace-expansion@5.0.9` and the development
`@typescript-eslint/typescript-estree@8.69.0 -> minimatch@10.2.6` path.
The shared minimatch/brace lock entries are not marked dev/peer and remain in
the filtered audit. Advisory IDs:
`GHSA-q2hr-2g5m-vwhr`, `GHSA-qhr7-859c-m2p7`, `GHSA-6j4f-fj2g-mc7p`.
No audit fix or unrelated upgrade was applied. The unfiltered npm-ci summary
also reports nine vulnerabilities including dev/peer dependencies; the requested
filtered audit is the one reported as a gate above.

**NON ESEGUITO:** full secret materialization/D3 characterization on 2026.9.9 and
2026.10.5; the old default-account characterization on 2026.10.5; runtime tests on
2026.10.1; production or external XMPP/Prosody authentication and traffic;
Node versions/platforms other than the stated Linux/Node 24 environment.
The old four-consumer packed harness targets 2026.8.2 only; the separate real
consumer probe supplies the newer-host loading/registration evidence.

The maintained security assertions cover STARTTLS before credentials, fail-closed
authorization before routing/dispatch, verified MUC identities and configured
rooms, account separation, SecretRef ownership/inheritance, governed reconnect,
XEP-0198 resume/fresh-session behavior and bounded teardown. No production
configuration, credentials, sessions, workspaces, databases, other repositories
or operational infrastructure were accessed or modified.

### Compatibility and metadata review

| OpenClaw | Classification | Evidence and limits |
| --- | --- | --- |
| 2026.8.2 | **DIMOSTRATA** for the tested SDK/plugin contracts | Real build, complete suite, installed tarball types, native/ESM loading, actual registration and runtime checks; both aligned and native mixed-Zod graphs |
| 2026.9.9 | **DIMOSTRATA** for the tested SDK/plugin contracts | Real build, complete suite, installed tarball types, loading/registration and public runtime checks; private secret/D3 characterization not run |
| 2026.10.5 | **DIMOSTRATA** for the tested SDK/plugin contracts | Real build, complete suite, installed tarball types, loading/registration and public runtime checks; broader private-host harnesses not run |
| 2026.10.1 | **NON VERIFICATA** | No real installation/runtime suite in this iteration; known factory location is insufficient |
| Other versions / field operation | **NON VERIFICATA** | No sufficient evidence in this iteration |

Recommendation for coordinator review: retain the existing minimum rather than
raise it to conceal a regression. The package is still actually built against
2026.8.2, so its build metadata remains accurate for this artifact. Public claims
should distinguish the exact tested hosts from untested versions and environments.
The three-host evidence does not prove every version covered by `^2026.8.2` or
the complete range implied by the README. No metadata or general compatibility
claim was changed; release readiness remains a separate decision.

This is the second remote checkpoint only. No version bump, merge, tag, release
or deployment is included.
