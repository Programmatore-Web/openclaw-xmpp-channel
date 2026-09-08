# D5 agent presence design

Target: `@openclaw/xmpp` 4.1.1, OpenClaw 2026.8.2, installed `@xmpp/client`
0.14.0. The dependency range remains `^0.14.0`.

## Verified SDK and runtime surfaces

Inspection used the exact installed npm package `openclaw@2026.8.2`, including
its declarations and distributed implementation, not a proposed API.

- `openclaw/plugin-sdk/channel-contract` publicly exports `ChannelGatewayContext`
  and `ChannelAccountSnapshot`. The gateway passes `getStatus: () =>
  ChannelAccountSnapshot` and `setStatus: (next: ChannelAccountSnapshot) => void`.
  The plugin's `GatewayStartContext.getStatus` now uses that exact public snapshot
  return type. The local optional context fields remain compatible with existing
  callers/tests; the real gateway supplies the getter.
- The snapshot has `busy?: boolean`, `activeRuns?: number`,
  `ingressUnavailable?: true` and `lifecycle?: "starting" | "ready" |
  "recovering" | "blocked" | "stopped"`. Ingress is intentionally optional-true,
  distinct from transport `connected`. Lifecycle is a recorded account condition,
  not inferred XMPP reachability. D5 uses only the four requested signals.
- The implementation in `server-channels-D8wMv0vh.js` wires the getter directly
  to `getRuntime(channelId, id)`, which reads the account runtime map. `setRuntime`
  merges status patches; it does not emit a public status-change notification or
  calculate active runs for an external plugin automatically.
- Public `PluginRuntime.events.onAgentEvent` emits run events containing run ID,
  stream, data and optional session/agent identity. It is not an account snapshot
  subscription and does not cover arbitrary blocked/ingress/config changes.
  `onSessionTranscriptUpdate` concerns transcript updates. The public channel
  context registry's `watch` observes capability registration/unregistration,
  not operational status changes. None is a supported replacement for observing
  all four snapshot fields.
- `openclaw/plugin-sdk/channel-lifecycle.createRunStateMachine` is public. Its
  `onRunStart`/`onRunEnd` publish `activeRuns`, `busy` and `lastRunActivityAt`;
  `deactivate` stops its heartbeat and abort listener. Its implementation is in
  `channel-lifecycle.core-Bfr1S-LZ.js`. One tracker belongs to the account lifecycle,
  survives client reconnects, and wraps only authorized reply/reaction dispatch.
  It is deactivated on account stop/replacement and terminal reconnect exhaustion.
  Authorization, session routing and pairing decisions remain unchanged.

Chosen observation: one client-owned 1000 ms interval, created only after a safe
fresh reconciliation or safe resumption. The current account can own only one
such client. Disconnect cancels the interval and D5's pending waiters, listeners
and deadlines; it cannot cancel an application write already handed to xmpp.js.
Resumption recreates one interval, retaining the last successful logical
publication and any physically unresolved broadcast.
No process-wide agent-event listener or second run database is introduced.

The account snapshot describes work routed through this XMPP account. D5 does
not infer that unrelated work for the same agent on another channel makes this
account busy. Short runs between polls can be missed. The SDK tracker's own
60-second activity heartbeat exists only during active work and is separately
owned/deactivated by the account lifecycle.

## State machine and protocol

The only publishable operational states are `available` and `unavailable`.
Forced configuration selects one while connected. Auto selects `unavailable`
for any of the four signals above, otherwise `available`. The physical client
must be current, enabled, unaborted, ready and actually `online` before operational
presence can be sent. Snapshot `connected` alone cannot establish reachability.

Available:

```xml
<presence><priority>1</priority></presence>
```

Operational unavailable (still online):

```xml
<presence><show>dnd</show><priority>1</priority></presence>
```

Optional `<status>` contains only the corresponding configured text, escaped
by the XML builder. No `lastError`, `stateReason`, provider error or exception
becomes status text. The Thunderbird mapping supplied for D5 is ordinary presence
→ Available/Disponibile, `show=dnd` → Unavailable/Non disponibile, actual session
loss → Offline/Non in linea. DND never has `type="unavailable"`.

The controller compares state plus effective text with the last successfully
written broadcast for this client/logical session. It serializes publication,
does not record failed writes as success and sends no unchanged poll traffic.
Directed subscribe/probe replies use a fresh snapshot and do not change broadcast
deduplication state. There is no plugin-local subscriber cache.

## Physical publication ownership (P2 correction)

The original 5-second `bounded()` waiter released `publishing` in `finally`, even
if its underlying `send()` Promise remained pending. The 1-second watcher could
then create another uncancellable write on every later timeout cycle. Fake-time
regression against PR head `06e29779705570d3d5545314f204c9f0694c9def` starts one
unresolved initial broadcast and observes 1, 2, 2 and 4 application broadcasts at
5, 6, 10 and 20 seconds. The corrected controller observes 1 at every checkpoint.

Publication now owns one token containing the logical session identity, the
connected generation's abort signal, the state/text actually sent, and its eventual
physical outcome. Only actual `send()` settlement records that outcome. A wait
timeout reports the fixed warning and removes its deadline/listener, but retains
the physical serialization barrier. Subsequent polls allocate no additional write
or deadline while that Promise is pending. No application-wide timeout or session
retirement is introduced: D2 R2's connection-primitive budgets remain separate.

On current-generation success, the current publisher consumes the token, remembers
the value actually sent, and reads the latest desired state/text again. Any number
of intervening changes therefore produces at most one immediate corrective write;
changes that return to the sent value produce none. Failure is contained and leaves
the previous successful value intact; the next ordinary poll consumes the failed
token and can retry once. Failure does not create a recursive retry loop. If the
write never settles, there is no retry: the contact's last observed state may remain
stale until the write settles or the session is replaced.

Disconnect aborts the connected generation but keeps the token for possible SM
resumption of the same logical session. An old completion updates only its own
outcome: it cannot update `published`, clear a newer token, or schedule a correction.
After resumption, the current publisher can consume that same-session outcome on
readiness or the next poll and reconcile it with the current desired value. This
avoids another application publication while the first is unresolved and avoids
forgetting what a late successful write actually sent. Fresh reset creates a new
logical session identity and drops the old slot. Disposal drops the slot and all
D5 timers/listeners. Old callbacks cannot publish, change runtime status or revive
resources in either case. Native SM retransmission remains exclusively xmpp.js's
responsibility, including replay of a stanza already in its queue.

### Audit of other D5 wait budgets

The monitor supplies the original ready-client send with no asynchronous gate
between the ownership check and invocation. Inspection of installed 0.14.0
`@xmpp/client-core/lib/Client.js`, `@xmpp/connection/index.js`, TCP/TLS and WebSocket
transport implementations confirms that an ordinary send hands bytes to the socket
synchronously before awaiting write completion. The stream orders those bytes;
late or reordered Promise completions cannot reorder subscription stanzas.

| Site | Timeout / late completion, ordering and disclosure |
| --- | --- |
| Broadcast operational presence | Timer-driven repeat was the P2 flaw. One physical token now blocks further broadcasts through timeout and SM resumption; only the latest state is reconsidered after settlement. |
| Directed subscribe/probe presence | One write per authorized request, with no automatic retry and no broadcast-state mutation. A timed-out completion cannot read or disclose a newer snapshot. Previously authorized bytes already accepted by the transport cannot be recalled after revocation. |
| `subscribed` | One approval write per accepted request; concurrent approvals for the same bare JID are coalesced while the waiter exists. Timeout exits the handler, so late success cannot send its follow-up presence. A later explicit request is a separate authorization; `unsubscribe` invalidates the approval token and its stanza follows earlier bytes on the stream. |
| `unsubscribed` for incoming unsubscribe | One acknowledgement per request, no retry or late continuation. A later explicit subscription remains later on the wire even if its Promise completes first. No subscriber cache is retained. |
| Roster revocation `unsubscribed` | Sequential, one write per denied identity during reconciliation. Timeout ends reconciliation with global publication closed; late success cannot start the confirmation IQ or reopen the gate. No contact deletion. |
| Fallback roster-push IQ result | One response per valid incoming push, no retry and no status payload. Timeout/late completion cannot reattach its disposed stanza listener. The installed client's native `iqCallee` path owns its own single response and is not a D5 bounded send. |
| Roster IQ get | One request per reconciliation phase, with an unpredictable ID and generation-owned response listener. Timeout removes the listener and closes the global gate. Late write success/failure or a late result cannot resume the abandoned reconciliation. |
| Pairing-store lookup | Bounded foreign read, not a send. Timeout denies the request or reconciliation; late completion cannot grant trust or start a stanza. |
| Graceful stop (250 ms, in monitor) | One synchronous best-effort offline write followed by actual transport teardown. Late completion only settles the already bounded stop waiter; it cannot reconnect or create another stanza. |

The non-broadcast sites have no poll-driven accumulation or late automatic
continuations, so they retain their existing implementation. Separate incoming
requests can still cause separate protocol writes; the broadcast lock is not a
global socket queue or an inbound rate limiter. Generation guards stop work that
has not been sent; they cannot retract bytes or cancel native send Promises. Tests
hold installed TCP send callbacks past the deadline, reverse subscription callback
order, and settle writes after revocation/disposal. Resource tests hold a broadcast
for an hour of fake time: one unresolved write, one poll timer after the initial
budget expires, then zero D5 timers/listeners after disposal.

## Authorization and persistent revocation

Presence trust is a separate capability: explicit owner JIDs, explicit
`presenceAllowFrom`, or identities returned by
`runtime.channel.pairing.readAllowFromStore({ channel: "xmpp", accountId })`.
Full sender JIDs are normalized to bare JIDs. DM policy, `dmAllowlist`, group
policy and `groupAllowFrom` never grant this capability. Only an explicit `*`
in `presenceAllowFrom` permits public access; owner/pairing wildcards do not.
Store failure denies unproven requests and prevents global reconciliation from
being declared safe. Explicit configured trust does not depend on store access.

Trusted subscribe sends one directed `subscribed` followed by the current
operational stanza. Untrusted subscribe and probe are ignored. An unsubscribe
receives `unsubscribed`; no challenge or reciprocal subscription is created.

Fresh-session reconciliation sends a normal roster IQ get with an unpredictable
ID, validates response ID and server origin (no `from`, or our bare JID), and
requires a roster query and valid items. It inspects `from`/`both` subscribers
and explicit preapprovals, reevaluating current trust. Unauthorized entries receive
`unsubscribed`, without a roster delete. If revocations were needed, a second
roster get confirms no unauthorized receiving subscriptions remain. This follows
[RFC 6121 roster and subscription cancellation semantics](https://www.rfc-editor.org/rfc/rfc6121.html#section-3.2).
Server-originated roster pushes are acknowledged and never cached as local trust.
On the installed client, `iqCallee.set` handles these pushes through the native IQ
dispatcher, avoiding a duplicate automatic IQ error. That API has no unregister:
one inert routing bridge remains in the retired client's native middleware, with
its D5 handler detached on disposal. Reconnects never add another route. Minimal
clients without the IQ module use a removable stanza responder instead.

Roster requests use a small cancellable stanza listener because installed
`@xmpp/iq` 0.14.0's public `iqCaller.request/get` lacks cancellation and its
handler/deadline can outlive client disposal. D5 bounds waiting to 5 seconds with
a generation abort guard; listeners and deadlines are removed on completion,
error, timeout or cancellation. Underlying foreign IO is not cancelled by this
waiting budget; physical broadcast ownership follows the rules above. No timer authorizes
presence merely because time elapsed. Warning logs use a fixed message without
roster identities, store paths or exception content.

Reconciliation failure leaves global publication closed for that logical session.
A fresh login retries. SM resumption does not reopen a failed gate. The roster task
is independent of connected status, Carbons and configured MUC joins: roster or
pairing-store failure does not make the messaging transport fail. A trusted
directed probe/subscription can still receive presence while the global gate is
closed. Contact UI status can therefore be absent while messaging still works.

Policy/pairing revocation is enforced before the next fresh initial publication.
Changes to pairing during a live/resumable session require an account reload for
persistent server subscription revocation. Trusted incoming probes/subscriptions
always use the current pairing store. Other clients on the same JID can edit the
server roster independently; D5 is not a roster-administration lock across clients.

## Fresh session, resumption and shutdown

Fresh `online` preserves D2's immediate MUC identity invalidation and SM readiness
gate. After readiness, presence resets its publication state, reconciles the roster
and publishes once. Carbons, connected status and MUC initialization retain their
existing fresh-session path, independent of the roster task.

Native 0.14.0 SM emits `resumed` before `_ready(true)` sets client status to online.
D5 checks presence on the next microtask, after that native readiness transition.
It retains the previous successful publication, any unresolved physical broadcast
and the roster gate. Unchanged state sends nothing; a changed state sends one
corrective stanza once the physical publication slot permits it. Carbons, roster fetch
and MUC joins are not repeated. Native SM retransmission of unacknowledged stanzas
is still owned by xmpp.js and is distinct from a new logical publication.

Deliberate current-account shutdown cancels operational tasks synchronously.
If a current established stream is still online, it starts one best-effort
`<presence type="unavailable"/>` before transport teardown. Waiting for the write
is bounded to 250 ms and uses the original send, not an async initialization gate. Application
callbacks are already disabled. The transport cannot reconnect, and the D2 total
5-second disposal budget remains. Stale or disconnected clients cannot take this
path. Abrupt loss sends neither DND nor synthetic offline; the server determines
resource loss, potentially after its SM retention timeout. Another live resource
for the same JID can keep the contact online.

D5 does not issue room-specific occupant `show` updates or change MUC identity,
whois, authorization or join policy. Thunderbird direct roster presence is the
interop target. Live Thunderbird/server field verification remains separate from
the deterministic tests and the supplied verified client mapping.
