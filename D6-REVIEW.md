# D6 presence semantics refinement

Base: `d49d0bbd83547c3844ee6f26f71e418f7474f3ac`, tree
`3ba93881185c2cfdcb63a22ed16614981a212ead`. Package stays `@openclaw/xmpp`
4.1.1; exact `@xmpp/client` 0.14.0; OpenClaw peer `^2026.8.2`, plugin API
`>=2026.8.2`, build target 2026.8.2. No schema change is needed.

## A. Analysis recorded before implementation

Operational XMPP presence reports whether the account can accept work, not
whether it is currently processing work.

### Exact D5 publication path at the base

1. Gateway `createChannelManager` owns the per-channel/account runtime map.
   `setRuntime` merges patches, preserving other fields. In 2026.8.2,
   `startAccount` receives `getStatus: () => getRuntime(channelId, id)`;
   in 2026.9.2 `createAccountContext` supplies the equivalent getter.
   Task-scoped `setStatus` rejects replaced task writes in both versions.
2. `src/monitor.ts` passes that context to `createPresenceController` in
   `src/presence.ts`. `read()` calls `ctx.getStatus()` (or an account-ID-only
   fallback) and passes the snapshot and account presence config to
   `derivePresence()`.
3. D5 `derivePresence()` consumes exactly `busy`, `activeRuns`,
   `ingressUnavailable`, and `lifecycle`. Auto DND is the OR of `busy === true`,
   `(activeRuns ?? 0) > 0`, `ingressUnavailable === true`, and
   `lifecycle === "blocked"`. It also reads config `mode`, `availableText`, and
   `unavailableText`. No other status field, including `connected`, determines
   this value. Empty configured text becomes absent text.
4. `publish()` calls `read()` only after current-session and roster checks,
   compares state/text with the last successful broadcast, and reserves one
   physical publication slot. It calls `buildOperationalPresence(next)` and
   the controller's guarded `send()`. Available has no `show`; operational
   unavailable has `show=dnd`; both have priority 1 and no `type`.
5. The monitor provides the original bound `xmpp.send`, after its existing SM
   readiness gate. The controller checks ownership immediately before invoking
   it. Installed 0.14.0 `@xmpp/client-core/lib/Client.js` delegates to
   `@xmpp/connection/index.js`; that path serializes the stanza and hands bytes
   to the socket before awaiting write completion. This is the physical send.
   Operational presence does not pass through D3's visible-message timestamp
   branch in the monitor's wrapped send.
6. Trusted subscribe/probe handling authorizes first, then independently calls
   `buildOperationalPresence(read(), to)` through the same guarded send.
   Directed replies read current state without waiting for a poll and do not
   alter broadcast deduplication.

### Status producers and admission evidence

Inspection uses both exact installed npm distributions, including declarations
and implementation; no production service or inferred provider capacity.

| Signal | Verified meaning and producer | D6 auto rule |
| --- | --- | --- |
| `busy?: boolean` | SDK `createRunStateMachine.publish()` writes `activeRuns > 0` alongside `lastRunActivityAt`. | Ignored for availability. |
| `activeRuns?: number` | `onRunStart` increments, `onRunEnd` decrements with a zero floor; a 60-second activity heartbeat republishes while work exists. | Ignored for availability, including concurrent work. |
| `ingressUnavailable?: true` | Snapshot declaration identifies inbound admission as independent of `connected`. Gateway start-failure handling sets it for `CHANNEL_INGRESS_UNAVAILABLE`, including wrapped causes; `ChannelIngressUnavailableError` represents failure to open durable ingress. Startup clears it with `undefined`. | Exactly `true` selects DND while genuinely online. |
| `lifecycle` | Recorded `starting`, `ready`, `recovering`, `blocked`, or `stopped`, independent of inferred transport health. `channelBlockedPatch` records `blocked` and terminal disconnect; the manager preserves terminal blocked state until explicit ready recovery or new startup. | Only `blocked` selects DND while genuinely online. |

The run tracker has no admission decision, maximum count, quota or capacity
check. Its `isActive()` returns its lifecycle-active flag, independent of count.
This is corroborated by the consumer path: `src/monitor.ts` creates one tracker
per account; `src/inbound.ts` authorizes the sender, resolves routing/session,
then `trackedDispatch` checks only `runState.isActive()`, calls `onRunStart`,
awaits the SDK dispatcher and calls `onRunEnd` in `finally`. A second authorized
dispatch can enter while the first is active. Reply ownership also checks
client identity and lifecycle activity, never `busy` or a run-count threshold.
Thus these fields account for activity rather than provide a mandatory XMPP
admission gate. D6 retains all accounting and D3 send ownership.

The XMPP plugin does not currently publish `ingressUnavailable` or `blocked`
itself and does not use the host durable-ingress monitor. These remain existing
explicit snapshot signals, not a claim that XMPP automatically detects quota,
model, tool, CPU or queue saturation. Gateway `getStatus` reads the raw runtime
map; a separate display snapshot can synthesize blocked credential status, but
D6 does not add that display projection or any new inference to this path.

### OpenClaw 2026.8.2 versus 2026.9.2

- Both distribute identical `channel-lifecycle.core-Bfr1S-LZ.js`, SHA-256
  `256c9dac77eec5aaf7c2b0dc97b8804174a43b3fc65cf88e5cf505e57ced518d`.
  The four snapshot field types and meanings are unchanged.
- Gateway bundles are `server-channels-D8wMv0vh.js` and
  `server-channels-D39cmOPC.js`. `getRuntime`/`setRuntime` retain the same merge
  and lifecycle-selection logic. Both clear ingress on startup and set it for
  classified ingress failures. Neither derives admission from busy/run count.
  The exact getter/merge block is byte-identical, SHA-256
  `5ba38b20783a4f033fdede6e16d359308082e4065fced1a30df9e3e718461fde`.
- 2026.9.2 introduces lifetime/capability leases, registry scoping, HTTP route
  handoff ownership and additional stale/closing-task guards. Its status writer
  releases route handoff on ready or terminal status. These are real ownership
  differences, not changes to the four signals or the run tracker. XMPP does
  not register an HTTP ingress route. Both versions retain the public gateway
  getter and guarded writer used here; runtime validation covers both hosts.

### Lifecycle, polling and configuration audit

The controller requires a live connected generation, non-aborted signal, current
client and actual `entity.status === "online"`. The monitor additionally owns
account/client identity, enabled state and abort state. Fresh online waits for
SM readiness, resets logical publication and reconciles roster authorization.
One 1000 ms poll exists after reconciliation; unchanged state/text sends nothing.
Suspend cancels poll/waiters/approvals. Resume retains roster/publication/physical
send ownership and reconciles on the native ready microtask. Fresh fallback
reconciles again. Dispose removes timers/listeners; late callbacks cannot revive
publication. These mechanisms need no implementation change for D6.

The only modes remain `auto`, `available`, `unavailable`. Forced modes override
all four signals while the current session is online. Neither mode establishes
a resource. Derived `OperationalPresence.state = "unavailable"` means online
DND, never offline. Actual resource loss remains authoritative. Graceful current
online stop attempts `type="unavailable"` with the existing 250 ms waiter before
teardown; abrupt loss and stale clients do not fabricate an offline stanza.

### Documentation scope

- `README.md`, “Agent presence in Thunderbird”: update the unavailable table
  row and auto/poll/manual-mode paragraph; point to this current decision.
- `AGENT-PRESENCE.md`: preserve the historical D5 four-signal design and P2
  evidence; add a prominent pointer to this superseding semantic decision.
- `D3-REVIEW.md`: preserve dispatcher-accounting history; add a D6 cross-reference
  next to its D5-preservation statement to disambiguate availability.
- Repository Markdown search found no other current activity-to-DND guidance.
  No changelog history, transport/auth semantics or package metadata is rewritten.

## B. Implementation and acceptance coverage

`src/presence.ts` is the only production code change: auto selects DND exactly
when ingress is unavailable or lifecycle is blocked. Ordinary processing stays
Available, including busy/count combinations with inconsistent activity values.
Forced modes and configured text retain precedence and compatibility. No schema,
SDK accounting, D3 timestamp, transport, authorization or lifecycle implementation
changes are made.

Changed review files are `src/presence.ts`, `test/presence.test.ts`,
`test/established-reconnect.test.ts`, `test/d3-outbound-status.test.ts`,
`scripts/test-d3-runtime.mjs`, `README.md`, `AGENT-PRESENCE.md`, `D3-REVIEW.md`, and
this new `D6-REVIEW.md`. Existing D5 transition tests now use explicit ingress
failure/recovery; their serialization, timeout, authorization and ownership
assertions remain. Historical D5 and D3 evidence is preserved with cross-references.

| Required case | Executable evidence |
| --- | --- |
| 1–5: idle, busy, one/multiple runs, busy plus runs | `presence.test.ts`, D6 matrix: eight activity snapshots, both implicit default and explicit auto. |
| 6–8: ingress, blocked, both, regardless of activity | The same matrix crosses all three gate combinations with eight activity snapshots; controller transition tests exercise polling and recovery. |
| 9–10: forced available/unavailable | Both modes are tested online against all matrix snapshots, including all four signals asserted together. State and stanza type are checked. |
| 11: no fabricated online resource | All three modes exercise controller `ready` and trusted directed responses before online and after disconnect/replacement, even with snapshot `connected: true`. Native monitor abrupt loss also covers all modes. |
| 12–13: ordinary authorized DM runs | D3 monitor fixture retains the real SDK tracker. Three consecutive runs and two overlapping dispatches remain available across multiple polls, processing, reply and run end; the second dispatch is admitted while the first runs. |
| 14–15: real transitions, unchanged polls | Controller ingress/blocked/both transitions each yield exactly `[available, DND, available]`; activity changes and repeated unchanged polls add no broadcasts. |
| 16: D3 outbound status | Real physical-send ownership assertions remain; D6 sequential/concurrent tests also assert successful `lastOutboundAt`. Both host versions exercise callback, routed, suppressed and failed DM/MUC delivery. |
| 17: replaced lifecycle/client | Pending authorization, pending writes, abort during derivation and six account reloads reject old publication; retired host task patches remain rejected. |
| 18: SM resume | Native resume changes busy/count during outage in both cases: unchanged genuine availability publishes nothing, ingress failure adds exactly one correction. Existing pending-write/resume and fresh-session roster tests remain. |
| 19: graceful shutdown | Existing native abort/disable/cleanup tests retain exactly one `type="unavailable"` before stop; bounded wait and readiness/stale-client exclusions remain. |
| 20: trusted directed presence | Subscribe and probe read activity-only, ingress-failed, blocked and recovered snapshots immediately. Unknown senders stay denied even with open DM policy; existing pairing/canonicalization/roster tests remain. |

`scripts/test-d3-runtime.mjs` extends the existing local host characterization.
It keeps the real Gateway manager/getter/writer, SDK dispatcher, run tracker,
outbound routing and status renderer. A paused fixture reply resolver permits a
poll while a real authorized dispatch publishes `busy: true, activeRuns: 1`.
After the run, explicit Gateway patches exercise ingress recovery, terminal
blocked stickiness, explicit ready recovery, forced modes and the physical online
guard. Activity `3` in the later patch phase is a deliberate fixture snapshot;
concurrent admission itself is exercised by the monitor/real-tracker unit test.
Model resolution, session storage and XMPP socket construction remain local
fixtures. No model request, live XMPP server or Thunderbird field test is involved.

## C. Validation

Final runtime: Node 22.23.2, npm 10.9.8, satisfying the package engine range.
The pre-change D6 controller tests detected the old behavior: 11 failed,
39 passed. The final focused selection passes 57/57 (222 unrelated cases skipped
by `-t D6`). The full suite has no skipped or failed cases.

| Gate | Result |
| --- | --- |
| Focused D6: three changed test files, `-t D6` | 57 passed. |
| Full presence/controller suite | 153 passed. |
| D5 native presence/lifecycle group | 37 passed, including SM resume, roster and graceful shutdown. |
| Additional D5 config/accounting/listener coverage | 11 presence config, 3 SDK authorized-accounting, 14 presence-listener tests passed. |
| D1 online/SM readiness (`online-lifecycle.test.ts`) | 47 passed, including 13 SM readiness recovery tests. |
| D2 reconnect/transport | 96 established-reconnect (including the 37 D5 cases), 19 reconnect, 12 transport-governance, 11 STARTTLS, 1 strict loopback failure test passed. |
| D3 physical outbound status | 30 passed. |
| DM/MUC authorization | 6 DM and 5 MUC authorization tests passed; 5 DM security-adapter and 5 MUC identity tests also passed. |
| Presence authorization and roster | Within the 153: 14 subscription/probe, 45 canonical trust, 16 persistent roster, 7 one-shot write audit tests passed. |
| Full suite | 757 passed in 30 files, 0 failed, 0 skipped. |
| OpenClaw 2026.8.2 local runtime characterization | 8/8 passed with D3 and D6 assertions. |
| OpenClaw 2026.9.2 local runtime characterization | 8/8 passed with D3 and D6 assertions. |
| Build, lint, format | Passed, including extra format checks on changed tests and runtime script. |
| Whitespace and complete diff | `git diff --check` and strict apply whitespace check passed, including the new review file. |
| Production dependency audit | `npm audit --omit=dev`: 0 vulnerabilities. |
| Package dry run | `npm pack --dry-run`: 129 files, package 4.1.1; expected built distribution present. |
| Packed runtime | `npm run test:packed-runtime`: 4/4 passed (clean, compatible, conflicting, override); intentional incompatible override rejected before native XMPP loading. |

Counts for named groups are subsets of the full suite and overlap where stated;
they are not additional independent test totals. Commands:

```sh
npm test -- --run --maxWorkers=2 test/presence.test.ts test/established-reconnect.test.ts test/d3-outbound-status.test.ts -t D6
npm test -- --run --maxWorkers=2
npm run build
npm run lint
npm run format:check
node node_modules/prettier/bin/prettier.cjs --check test/presence.test.ts test/d3-outbound-status.test.ts test/established-reconnect.test.ts scripts/test-d3-runtime.mjs
node scripts/test-d3-runtime.mjs
node scripts/test-d3-runtime.mjs <disposable-2026.9.2-host-directory>
npm audit --omit=dev
npm pack --dry-run
npm run test:packed-runtime
git diff --check
```

The initial broad sandbox attempt was not accepted as validation: registry DNS
and loopback access were restricted, child-process checks failed, and concurrent
host probes overlapped the packed-types test's clean rebuild of `dist`. Final
validation uses the engine-valid runtime above, bounded workers, local loopback
permission and separate build-dependent gates. No product workaround was added.

## D. Human review boundary

The complete diff and its SHA-256/size/stat/apply verification are supplied as
separate review artifacts against the exact base above. They include this new
file and every tracked edit, with no generated distribution, tarball, disposable
host installation or private environment material. The repository index remains
untouched. Commit, push, PR, tag, release and npm publication are not performed.
No production access, deployment or field candidate creation is performed.
Human review and later Thunderbird field acceptance remain separate.
