# Reconnect ownership and disposal (@xmpp/client 0.14.0)

At most one connection-producing operation for an account may be effective at a time.
The plugin schedules recovery; `@xmpp/reconnect.stop()` runs before initial startup
and on disposal. Its native disconnect listener and fixed 1000ms timer remain stopped.
`connect()` is authorized only inside the transport adapter's `run()` operation.
`open()` remains available for native STARTTLS/SASL stream restarts on the current entity.

## Account and client ownership

`accountLifecycles` records account ownership separately from `activeClients`.
An explicit account restart disposes the previous owner before starting a new client.
Plugin replacements use the same account lifetime and its single abort listener.
`clientDisposers` is a WeakMap; disposal deletes its entry and the account's reference
to that disposer, removes plugin lifecycle/error/stanza/SM listeners, cancels online
readiness and MUC waits, clears message-mapping expiry timers, and stops keepalive.
Old callbacks cannot publish status for a newer account owner.

Account cleanup calls this same disposer before deleting state. Aborting first or
removing state first both finish with running/connected false, no pending retry,
no active client and no retained account lifecycle. Terminal exhaustion retains
only the account lifetime until abort, so the supervisor cannot restart it implicitly.

## Retry policy and Stream Management

The scheduler increments attempts when scheduling: 1000, 2000, 4000, 8000ms, doubling
to a 60000ms cap. Attempt 20 is the last attempt. Transport connect/open activity
never resets the count. Exhaustion aborts recovery and disposes the active client.

A settled failure of an established session reuses its entity, resource, SM ID,
counters and outbound queue. Failed transport attempts use `disconnect()`, not
`stop()`/`offline`. Successful native SM `resumed` resets recovery, marks connected
and restores keepalive without repeating Carbons, presence or MUC initialization.
A failed resume followed by fresh `online` waits for native SM readiness, then resets
recovery and initializes Carbons, presence, connected status and configured MUCs.
At fresh `online`, before waiting for readiness, the monitor cancels the previous
online generation and clears joined rooms, pending joins and verified occupant
real-JID observations. An old room/nickname observation cannot authorize traffic
in the new session; new XEP-0045 real-JID presence is required by group allowlists.
The `resumed` path retains joined rooms and occupant identities without rejoining.

An operation timeout, or disconnect during an unfinished protocol negotiation,
retires the entity. Native SM procedure listeners have no cancellation API and must
not consume a later stream's responses. A new entity is required in those cases;
SM resumption is retained for ordinary settled transport failures, not promised
across an abandoned, uncancellable negotiation. Late operations on a retired entity
cannot attach a live socket, open a stream, publish lifecycle events or enable SM timers.

## Redirects

The adapter replaces the complete native `see-other-host` stream-error branch,
including its detached `disconnect()`. It preserves the service protocol and XMPP
identity/domain, validates the host/port target, and serializes close before connect.
A current connection attempt may follow at most **two successive redirects**,
within [RFC 6120 §4.9.3.19](https://www.rfc-editor.org/rfc/rfc6120.html#section-4.9.3.19)'s
suggested range of 2–5. The third redirect ends the attempt without another immediate
connect. Malformed targets also end the attempt; they do not immediately reconnect
the original host. Both failures close through the bounded transport path and transfer
recovery to the existing plugin exponential scheduler, retaining the last valid service.

Redirects in the same attempt share this allowance, including those followed on the
same entity. A scheduled plugin retry starts a new allowance; its reconnect attempt
count/backoff remains unchanged. Stable fresh online (after the SM readiness gate) or
valid SM resumption clears redirect history. Raw connect/open/online activity does not.
Thus an uninterrupted redirect loop can produce at most two extra connections per
scheduled attempt and still reaches the 20-attempt terminal limit.

A pending plugin retry keeps its existing delay/count and uses the redirected service. Executing recovery finishes
its bounded operation before another connection can become effective. The destination
also survives a required fresh replacement within this account lifetime.
Abort, disable, replacement and terminal exhaustion invalidate redirects. Subsequent
failures use the plugin backoff. The adapter performs the native STARTTLS negotiation/upgrade sequence while
capturing the TLSSocket before awaiting its handshake. It uses the same
`tls.connect({ socket, host: domain })` certificate-verification options. It attaches
the secure socket only after `secureConnect` and retains the cancellable TLS 1.3
compatibility delay. SASL and the credential security check remain native/unchanged.
Only `proceed` in `urn:ietf:params:xml:ns:xmpp-tls` authorizes the TLS upgrade,
matching installed `@xmpp/starttls` 0.14.0 exactly. Missing/wrong namespaces or other
responses fail STARTTLS and close within the existing budget without TLS or restart.

An initial redirect explicitly releases the initial startup waiter before its
intentional disconnect. When the current entity is still safe to reuse, governed
serial close/connect/open owns that same attempt; the released waiter cannot
schedule backoff or clear the redirected negotiation deadline. If an unfinished
protocol negotiation has already made the entity unsafe to reuse, it is retired
and recovery continues through the plugin backoff while retaining the last valid
redirected destination. Malformed redirects, redirect exhaustion, or redirect
failure transfer recovery exactly once to the plugin scheduler. Disposal also
releases the startup waiter and all of its listeners.

## Budgets and captured transports

- Connect, every stream open/restart, STARTTLS negotiation and TLS handshake:
  the entity's native timeout (2000ms by default), covering the whole owning operation.
  An open deadline includes its header write; the STARTTLS negotiation deadline
  includes both sending the request and receiving the response.
- Graceful disconnect: 5000ms total, matching the existing stale-stop budget and
  allowing two native 2000ms close phases plus a 1000ms allowance.
- Stream negotiation and the existing SM readiness gate: 10000ms each.
- Disposed-client `stop()`: 5000ms. Sockets are already destroyed before this wait.

**Writes have no independent delivery deadline.** Normal message, presence, IQ,
keepalive and MUC sends do not inherit a two-second timeout. The write adapter only
observes completion and cancellation. When an owning open/STARTTLS/negotiation/close
operation times out, entity retirement cancels pending writes before their late
callbacks can advance a protocol operation. The same cancellation runs on abort or
replacement. A stuck close write is bounded by the whole 5000ms close budget.
No application-delivery timeout policy is introduced.

Socket references are captured before native disconnect can detach them. TCP sockets
and TLS wrappers' underlying TLSSockets are destroyed on failed close/disposal.
Late socket attachment is destroyed and rejected before native connect can reuse it.
Destroy/close failures are contained. Native parser waits and IQ deferreds are cancelled
on retirement; all plugin operation timers and listeners are removed.

## Exact library coupling and tests

The adapter depends on 0.14.0's lower-level `connect/open/disconnect`, `_onElement`,
`_onSeeOtherHost`, `_attachSocket/_detachSocket/_detachParser`, `_closeSocket`, `_ready`,
`socket`/`parser` references, SM `enabled` flag, IQCaller `handlers` Deferreds, and TLS
wrapper `socket`/`timeout`. These internals must be rechecked before a dependency upgrade.
It does not modify installed packages. It leaves native SM resume/fresh negotiation, SASL, resource binding and middleware
in place. Only pre-TLS features are consumed by the owned upgrade; features on the
secured stream pass through the original middleware.

`test/established-reconnect.test.ts` uses the installed reconnect, middleware,
resource-binding and SM modules with simulated transport/server responses.
It characterizes native 1s retries and verifies plugin backoff, real resumption,
fresh fallback, terminal exhaustion, redirects and repeated lifecycle disposal.
`test/transport-governance.test.ts` exercises real 0.14.0 connection primitives and
the real TLS wrapper, including never-settling operations and late continuations.
`test/starttls-governance.test.ts` covers TLS capture before handshake, cancellation,
certificate-error containment, secure readiness and the TLS 1.3 delay.
`test/online-lifecycle.test.ts`, `test/reconnect.test.ts`, `test/rooms.test.ts` and
`test/transport-failure.test.ts` cover readiness, scheduler, MUC cancellation and
strict unhandled-rejection containment with a loopback transport fault.

The R1 tests exercise bounded A → B → A → B redirects, invalid targets, stable
resumption/fresh-session resets, repeated redirect loops through all 20 scheduled
attempts, and cancellation. The R2 tests hold ordinary message/presence/IQ sends
for 5000ms without retirement or a write timer, then complete them successfully.
They also verify header/restart, STARTTLS and close deadlines, and late-write cancellation.

R3 tests reject wrong/absent STARTTLS namespaces before `tls.connect` and secured
restart. R4 holds an initial redirected connect for 1500ms, verifies zero retry at
1000ms and normal SM readiness, and separately proves the redirected negotiation
deadline fires at 10000ms. It covers failure, invalid/looping redirects, abort,
replacement and deterministic replacement after transport timeout. R5 uses real
SM resume/fresh middleware, presence tracking and inbound authorization: fresh
fallback fails closed without new real-JID presence, while resumption preserves
the previous room identity and authorized group traffic without reinitialization.
