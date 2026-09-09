# D3: outbound runtime status ownership

Review base: `main`, commit `38c6ba03331db673cc6adb11ea1670ca5f0792fe`,
tree `cbdd6daaefd296a32e8a74edcfb202b57f4bc25c`.
Working branch: `fix/d3-last-outbound-at`. No commit, push, PR, tag or publication.

## A. Root cause and evidence

The plugin published outbound success only inside the inbound reply callback.
That callback is **not the common delivery boundary**. OpenClaw can deliver a
visible source reply through its outbound routing machinery, which calls
`channel.outbound.sendText` instead. `sendXmppMessage` awaited the physical send
but never published account status. The routed host path also did not record an
outbound activity timestamp for the Gateway's fallback. Thus a successful send,
including a reply to an authorized inbound message, left the authoritative
Gateway account runtime and `channels.status` without `lastOutboundAt`.

This is reproduced against both exact hosts with their real dispatcher, routing,
monitor, Gateway account store and `channels.status` handler. The model resolver,
XMPP transport and inbound agent/session plumbing are deterministic local fixtures.
The routed fixture selects
`sourceReplyDeliveryMode: 'message_tool_only'` and calls the real host `routeReply`
from the resolver; this tests a routed source-reply owner without requesting an
LLM or allowing an automatic second reply. It is not a replay of a production
model run. Callback counts and adapter counts prove which path performed the send.

On the base, for each host, both DM and MUC routed sends succeed with one physical
body send, zero plugin delivery callbacks, a current account task, updated
`lastInboundAt`, and null `lastOutboundAt` in `channels.status`. The two corresponding
physical-failure cases also expose the missing adapter-owned `lastError` patch.
These four tests fail on the base and pass with the fix.

The field evidence is accepted as a confirmed defect. It does not include a trace
identifying the route selected in those particular runs. The tests prove an exact
code-level mechanism matching that symptom; they do not establish which route
each field reply used. No production connection or field validation was performed.

### Execution paths

1. **Callback DM/MUC:** `setupMessageHandler` -> `handleInboundMessage` -> sender
   authorization and inbound status -> `trackedDispatch` ->
   `dispatchReplyWithBufferedBlockDispatcher` -> plugin `dispatcherOptions.deliver`
   -> `debouncedDeliver` -> 500 ms timer -> `deliverReply` -> monitored `client.send`
   -> original XMPP send -> native write completion. DM and MUC use the same code,
   with different targets, authorization and stanza types.
2. **Core-routed source reply:** inbound/dispatch as above -> host `routeReply` ->
   `sendDurableMessageBatchCore` -> outbound delivery handler ->
   `xmppPlugin.outbound.sendText` -> `sendXmppMessage` -> monitored `client.send` ->
   original XMPP send. This path bypasses `deliverReply` and its buffer entirely.
   Direct callers of the outbound adapter use the same lower-level path.
3. **Status after the fix:** successful monitored send -> client/lifecycle ownership
   check -> monitor's guarded `setStatus` -> `ChannelGatewayContext.setStatus` ->
   Gateway `isCurrentTask()` check -> merged account runtime patch ->
   `getRuntimeSnapshot` -> plugin `buildAccountSnapshot` -> `channels.status`.
   No rendering changes or additional status store are involved.

In `@xmpp/connection@0.14.0`, `send` awaits `write`; `write` resolves/rejects from
the socket write callback. The plugin transport governor preserves that promise
and can reject it on retirement. The new timestamp follows that success; it is
not an XEP-0198 server acknowledgement or a recipient read receipt.

### The debounce hypothesis and lifecycle ownership

- The delivery promise currently acknowledges enqueueing, before physical send.
  This is real, but **does not itself revoke the Gateway account status sink**.
  A successful delayed callback on a current client updates status even after
  `trackedDispatch` calls `onRunEnd`. Real-host callback tests pass on the base.
- `createRunStateMachine.onRunEnd` publishes `activeRuns`, `busy` and
  `lastRunActivityAt`; it does not deactivate the account or erase timestamps.
  The account's `startXmppConnection` promise stays pending until stop/abort.
- The monitor's sink retains its client/lifecycle closure. It rejects patches
  after that client is disposed or its account owner is replaced. Independently,
  the Gateway rejects a patch when its captured account task is no longer current.
  Ending one dispatcher run does not change that task identity.
- A second concrete ownership defect existed in the buffer: its key contained
  only account and conversation. After replacement, an old batch could retain the
  old sink but look up the **new** active client at send time, or merge old text
  with a new batch. The new client could physically send while the old sink
  correctly refused publication. A late old dispatcher could also overwrite a
  newer pending batch. Replacement tests reproduce these failures on the base.
- The fix keeps the enqueue-only promise and existing run accounting. It does
  **not** claim that dispatcher completion proves physical delivery. Returning
  a promise that waits for each send would change coalescing because the host
  serializes delivery callbacks. Such a dispatcher contract change is unnecessary
  for the demonstrated D3 status failures and is not included here.

### OpenClaw comparison

| Contract | 2026.8.2 | 2026.9.2 |
| --- | --- | --- |
| Callback delivery vs routed `sendText` | Separate paths | Same relevant separation |
| Gateway account status | Merge patch only for current account task | Same relevant guard/merge |
| `onRunEnd` | Run accounting only | Identical lifecycle helper bundle |
| Routed outbound activity fallback | Remains null in the reproduction | Remains null in the reproduction |
| Retired Gateway task patch | Ignored | Ignored |
| Actual status integration | 8/8 pass with fix; 4/8 fail on base | 8/8 pass with fix; 4/8 fail on base |

The common `channel-lifecycle.core-Bfr1S-LZ.js` has SHA-256
`256c9dac77eec5aaf7c2b0dc97b8804174a43b3fc65cf88e5cf505e57ced518d` in both hosts.
2026.9.2 adds registry scoping to ChannelManager construction; the integration
fixture supplies `getPluginRegistry`. This does not change timestamp ownership.
The task-scoped channel runtime tracks registered context leases, not outbound
timestamp publication or individual reply-run ownership of the account task.

Host source locations inspected (logical source regions inside the published
bundles): `auto-reply/reply/provider-dispatcher.ts`, `auto-reply/dispatch.ts`,
`auto-reply/reply/dispatch-from-config.*`, `auto-reply/reply/route-reply.ts`,
`infra/outbound/deliver*`, `channels/run-state-machine.ts`,
`infra/channel-runtime-context.ts`, `gateway/server-channels.ts`,
`gateway/server-methods/channels.ts`, and `infra/channel-activity.ts`.

## B. Implementation

- `src/monitor.ts`: the existing monitored client now publishes success once,
  after the original send resolves, for a message with nonblank body text. It
  publishes a physical-send error for that same category and rethrows the original
  error. Both publications require current client/account ownership.
- `src/inbound.ts`: remove the callback-specific success patch. Capture client
  ownership at ingress, check it before enqueue and delayed delivery, and scope
  coalescing to that client. Prevent a retired send's final chat-state notification
  from using a replacement client. Empty/whitespace and exact reserved control
  text are omitted from the buffer before a quoted fallback body can be built.
- `test/d3-outbound-status.test.ts`: 23 regression/characterization cases with the
  real monitor, sender authorization and SDK run tracker.
- `scripts/test-d3-runtime.mjs`: opt-in integration gate using each installed exact
  OpenClaw host, with native Gateway `channels.status` output. Private bundle export
  discovery is test-only and rejects host versions outside the two characterized
  releases. All plugin SDK imports are resolved against the selected host.
- `D3-REVIEW.md`: this review record.

There is one common publication site for successful visible text sends. It covers
callback replies, core-routed/direct outbound, and pairing text sent through the
monitored client. Presence, IQ, read/chat markers, reaction protocol stanzas and
empty bodies do not count as outbound text. Core/channel-normalized control
payloads produce no body send; the callback buffer also filters reserved controls.
Reaction-triggered inbound dispatch continues to suppress its reply callback.

`sendText` still awaits `sendXmppMessage` and throws on failure. Its live monitored
client now owns authoritative timestamp/error publication; neither its caller nor
the status renderer has to infer success. Calling the low-level function with an
artificial unmonitored client does not constitute a running Gateway account.

D5 semantics are preserved: busy/activeRuns cover dispatcher work, including
awaited routed sends, and end before the callback's detached buffer is flushed.
No sleeps, status polling, new persistence store or presence-derived timestamp
were added. Existing asynchronous error containment is retained.

Package `4.1.1`, OpenClaw peer `^2026.8.2`, plugin API `>=2026.8.2`, build target
`2026.8.2`, exact `@xmpp/client: 0.14.0`, package lock and manifest are unchanged.

## C. Validation

All final gates use engine-valid **Node v22.23.2**. The default system Node was
v22.22.1, so a checksum-verified official v22.23.2 toolchain was used externally.
The exact 2026.9.2 registry archive was verified against its published SHA-512
integrity. Hosts, model/session fixtures and npm consumers are disposable local
directories; no SSH, VPN, production service, deployment or publication is used.

| Gate | Result |
| --- | --- |
| Final new D3 cases on unchanged base | 11 fail, 12 pass (23 total) |
| D3 cases with fix | 23/23 pass |
| D3 + existing inbound delivery tests | 45/45 pass |
| Full suite | 707/707 pass, 30 files |
| Explicit D1/D2/D5, DM/MUC auth, read-marker, reaction/room gates | 383/383 pass, 13 files |
| Real OpenClaw 2026.8.2 dispatcher/Gateway/status | 8/8 pass; base 4 fail, 4 pass |
| Real OpenClaw 2026.9.2 dispatcher/Gateway/status | 8/8 pass; base 4 fail, 4 pass |
| Build / lint / source format | Pass |
| Additional new test/script format | Pass |
| Runtime dependency audit (`npm audit --omit=dev`) | 0 vulnerabilities |
| `git diff --check` | Pass |
| Local npm pack / dry-run | Pass |
| Final `npm run test:packed-runtime` | 4/4 pass: clean, compatible, conflicting, override rejection |

The 383-case gate includes established SM/reconnect (94), online lifecycle (47),
transport governance (12), STARTTLS (11), strict loopback transport failure (1),
reconnect/backoff (19), keepalive (3), presence/D5 (112), inbound security (14),
read markers (7), reactions/actions (38), MUC identity (5), and rooms (20).
The full suite additionally covers authorization/channel contracts, runtime
compatibility and startup, encrypted stanzas, configuration and packed types.

The first sandboxed suite attempt could not spawn child Node processes (`EPERM`)
or run its loopback fixture. The unchanged checks passed with those local test
capabilities enabled. The npm cache was moved to a disposable writable directory
after a read-only-cache pack attempt. Neither required a code workaround.

Reproduce after installing dependencies and selecting an engine-valid Node:

```sh
npm run build
npx vitest run test/d3-outbound-status.test.ts test/inbound-delivery.test.ts
npx vitest run
node scripts/test-d3-runtime.mjs
node scripts/test-d3-runtime.mjs /tmp/host-2026.9.2/node_modules/openclaw
npm run lint
npm run format:check
npm audit --omit=dev
npm pack --dry-run
npm run test:packed-runtime
git diff --check
```

The alternate host directory must contain an actual installation of
`openclaw@2026.9.2`, with install scripts disabled. No repo lockfile changes are
needed. To reproduce the red cases, build the required base in an isolated
checkout, then copy only the new test and integration script into it.

## D. Review artifact and git state

The external review bundle contains a complete binary-capable diff against HEAD,
including all untracked review/test files, plus a SHA-256/size/line-count/file-stat
manifest and validation logs. The diff is checked for application against a clean
copy of the required base. It does not contain generated dist, npm tarballs,
local host installs or private environment paths.

HEAD and the local `origin/main` tracking ref remain
`38c6ba03331db673cc6adb11ea1670ca5f0792fe`. The real index is untouched. Work remains
unstaged on the dedicated branch for review; no commit/push/PR/tag/release/npm
publication or field candidate was created.
