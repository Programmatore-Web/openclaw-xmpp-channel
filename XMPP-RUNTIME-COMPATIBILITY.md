# xmpp.js runtime compatibility

The only validated xmpp.js implementation family is **exactly 0.14.0**.
The plugin depends on characterized internals, not only public APIs. A future
`0.14.x` release allowed by upstream semver ranges requires deliberate revalidation.
Package version remains `@openclaw/xmpp@4.1.1`; OpenClaw compatibility remains
peer `^2026.8.2`, plugin API `>=2026.8.2`, build target `2026.8.2`.

## Consumer policy and startup gate

The direct dependency is `@xmpp/client: "0.14.0"`. Its own 18 `@xmpp/*`
dependencies use `^0.14.0`, as do subsequent family dependencies. An exact client
pin alone therefore cannot constrain the implementations used by consumers.
The repository lockfile fixes development installs; it is not shipped or treated
as a consumer guarantee. No xmpp.js overrides, internal direct dependencies,
shrinkwrap, bundling, vendoring, postinstall mutation, or operator override are required.

`src/xmpp-runtime-compat.ts` owns the validated version and structured diagnostics.
`src/xmpp-runtime-imports.ts` records the reviewed upstream import sites. The guard
checks all 28 reachable `@xmpp/*` packages, including supporting helpers, and every
reachable copy, not merely one hoisted copy per name. This covers the complete
loaded family without another version policy for helper packages.

Registration, client creation, and transport adaptation assert compatibility.
`src/xmpp.ts` also validates before synchronously loading the native xmpp.js graph
or invoking its client/XML factories. All production runtime imports use this boundary;
type-only imports retain the upstream types. An incompatible deep export therefore
cannot preempt the guard with a native loader error. Supported Node engines can
load this synchronous ESM family with `createRequire`; no top-level await is added
to OpenClaw's synchronous native/Jiti loading path.

A mismatch stops startup before registration, native client construction, reconnect
control, or private transport/state access. For example:

```text
Unsupported xmpp.js runtime: validated @xmpp/client family is 0.14.0; resolved @xmpp/connection 0.14.1. Install the validated family and remove conflicting overrides, or revalidate before upgrading.
```

Unreadable/missing/malformed metadata or an unverifiable module layout also fails
closed. Public messages contain only fixed package names, bounded version strings
and remediation text; filesystem errors, paths, arbitrary metadata and causes are
not included. There is no runtime registry access.

## Resolution contract

Each reviewed dependency is resolved with `createRequire` anchored at the real
upstream importing file (including `client-core/lib/Client.js`, IQ caller/callee,
and STARTTLS's TLS Socket subpath). Metadata and the actual entry/subpath must agree.
The validated packages all have `type: module`, `main: index.js`, and no exports
map. Thus their explicit CJS and ESM resolutions agree. New conditional exports,
hidden metadata, unexpected entry layouts, or missing source files fail closed.
No ancestor-directory search or runtime source-string parsing is used.

Hoisted, nested and realpath-based symlink stores are supported. The tests include
a nested copy under an importing `lib` directory and a pnpm-style symlink store.
Normal npm/Yarn node_modules layouts use the same Node resolution. Yarn PnP/ZIP,
custom resolution hooks, browser bundles, and bundlers that
remove metadata are not characterized installation contracts. Preserve-symlink
Node flags are rejected because they alter dependency ancestry. Bundled packages
retaining the reviewed Node layout can be inspected, but this plugin bundles none.

The successful assertion is cached per module instance, matching Node's cached
runtime modules. Failures are not cached. Restart after changing dependencies;
live replacement of node_modules is not supported. This is a compatibility/version
guard, not a content-integrity check against packages that falsely retain `0.14.0`
metadata. Non-`@xmpp` dependency updates remain subject to ordinary audit/regression
review; they are not independently pinned by this compatibility policy.

## Authoritative coupling inventory

“yes” includes private state access and exact native lifecycle/routing behavior
that the plugin's adaptation assumes. “no” identifies preserved public/helper
behavior that is nevertheless checked as part of the loaded family. Owners below
were inspected in the installed 0.14.0 implementation, including deep import sites.
All rows resolved to 0.14.0 before and after hardening. Only the plugin's direct
client range changes from the base shown below to exact `0.14.0`.

| Package | Declared by (all upstream parents) | Declared range at base | Resolved after npm ci | Direct internal/behavior coupling? | Reason |
|---|---|---|---|---|---|
| `@xmpp/client` | @openclaw/xmpp | `^0.14.0` | `0.14.0` | yes | Client composition, native reconnect installation, ordered STARTTLS/SASL/SM/binding middleware, attached component objects. |
| `@xmpp/client-core` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | Client.connect transport selection and Transport/Socket/Parser delegation; inherited connection lifecycle; bind2/FAST composition used by SM. |
| `@xmpp/connection` | @xmpp/client-core, @xmpp/connection-tcp, @xmpp/tls, @xmpp/websocket | `^0.14.0` | `0.14.0` | yes | connect/open/disconnect/stop/restart/sendReceive/write timing; _onElement, _onSeeOtherHost, _attachSocket, _detachSocket, _detachParser, _closeSocket, _ready; _closeStream hooks, footer/footerElement and parser-end ordering; socket/parser/status/options references and lifecycle ordering. |
| `@xmpp/connection-tcp` | @xmpp/tcp, @xmpp/tls | `^0.14.0` | `0.14.0` | yes | TCP framing/header/footer and Parser/Socket prototypes delegated through client-core; callback-driven writes and socket lifecycle. |
| `@xmpp/reconnect` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | Native fixed 1000ms retry listener/timer, ownership and stop behavior before initial start and disposal. |
| `@xmpp/iq` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | IQCaller.handlers Map and deferred cancellation; request timeout lifetime; IQCallee middleware routing, exactly one roster-push reply, no unregister API. |
| `@xmpp/starttls` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | Exact proceed namespace check, sendReceive negotiation, TLS upgrade/attachment/restart sequence replaced by governed upgrade. |
| `@xmpp/stream-management` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | enabled/enableSent flags, enabled/resumed/failed events, _ready ordering, retained SM ID/counters/queue and native resumption/fresh fallback. |
| `@xmpp/tls` | @xmpp/client, @xmpp/starttls | `^0.14.0` | `0.14.0` | yes | TLS Socket wrapper's socket/timeout, secureConnect event, TLS 1.3 delay, detach/end/write behavior and ConnectionTLS delegation. |
| `@xmpp/tcp` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | TCP transport registration, connection-tcp subclass and Socket/Parser selection used by governed connect. |
| `@xmpp/middleware` | @xmpp/client, @xmpp/iq | `^0.14.0` | `0.14.0` | yes | Incoming/outgoing stanza contexts and ordered next() chain retained under _onElement interception; native IQ/SM routing. |
| `@xmpp/resource-binding` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | Native bind IQ completion calls _jid then _ready(false), before later SM readiness; fresh-session characterization. |
| `@xmpp/stream-features` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | Namespace-sensitive feature dispatch and next() ordering for STARTTLS, SASL, bind and SM. |
| `@xmpp/events` | @xmpp/client-core, @xmpp/connection, @xmpp/iq, @xmpp/reconnect, @xmpp/resolve, @xmpp/sasl, @xmpp/sasl2, @xmpp/starttls, @xmpp/stream-management, @xmpp/tls, @xmpp/websocket, @xmpp/xml | `^0.14.0` | `0.14.0` | yes | Owns the Deferred promise/reject objects stored by IQCaller; native promise/listeners/procedure timeout and cleanup semantics. |
| `@xmpp/xml` | @xmpp/client-core, @xmpp/connection, @xmpp/connection-tcp, @xmpp/iq, @xmpp/middleware, @xmpp/resolve, @xmpp/resource-binding, @xmpp/sasl, @xmpp/sasl2, @xmpp/starttls, @xmpp/stream-management, @xmpp/websocket | `^0.14.0` | `0.14.0` | yes | Owns Parser references/events detached during retirement and Element namespace semantics used by STARTTLS/stanza interception. |
| `@xmpp/resolve` | @xmpp/client | `^0.14.0` | `0.14.0` | yes | Wraps entity.connect; explicit URI delegates to captured native connect, with transport/socket attachment semantics for resolver fallback. |
| `@xmpp/websocket` | @xmpp/client | `^0.14.0` | `0.14.0` | no | Installed native transport and framing/parser helpers; plugin currently constructs TCP URIs. Checked as part of the loaded family. |
| `@xmpp/sasl` | @xmpp/client, @xmpp/client-core, @xmpp/sasl2 | `^0.14.0` | `0.14.0` | no | Preserved native authentication/stream restart behavior; public credentials callback and mechanism selection. Checked as part of the loaded family. |
| `@xmpp/sasl2` | @xmpp/client | `^0.14.0` | `0.14.0` | no | Preserved SASL2 and inline bind/SM negotiation. Checked as part of the loaded family. |
| `@xmpp/sasl-anonymous` | @xmpp/client | `^0.14.0` | `0.14.0` | no | Native mechanism registration; no private field access. Checked as part of the loaded family. |
| `@xmpp/sasl-plain` | @xmpp/client | `^0.14.0` | `0.14.0` | no | Native mechanism registration; no private field access. Checked as part of the loaded family. |
| `@xmpp/sasl-scram-sha-1` | @xmpp/client | `^0.14.0` | `0.14.0` | no | Native mechanism registration; no private field access. Checked as part of the loaded family. |
| `@xmpp/sasl-ht-sha-256-none` | @xmpp/client | `^0.14.0` | `0.14.0` | no | FAST mechanism registration; no private field access. Checked as part of the loaded family. |
| `@xmpp/jid` | @xmpp/client-core, @xmpp/connection, @xmpp/middleware, @xmpp/sasl2 | `^0.14.0` | `0.14.0` | no | Public JID construction/bare/string operations; canonicalization regression coverage. Checked as part of the loaded family. |
| `@xmpp/error` | @xmpp/connection, @xmpp/middleware, @xmpp/sasl, @xmpp/sasl2, @xmpp/stream-management | `^0.14.0` | `0.14.0` | no | Native stream/stanza/SASL error helper; no private field access. Checked as part of the loaded family. |
| `@xmpp/base64` | @xmpp/sasl, @xmpp/sasl2 | `^0.14.0` | `0.14.0` | no | Native authentication encoding helper. Checked as part of the loaded family. |
| `@xmpp/id` | @xmpp/iq | `^0.14.0` | `0.14.0` | no | Native IQ ID helper. Checked as part of the loaded family. |
| `@xmpp/time` | @xmpp/stream-management | `^0.14.0` | `0.14.0` | no | Native SM delay timestamp helper. Checked as part of the loaded family. |

## Deliberate upgrade procedure

1. Create a dedicated upgrade branch.
2. Install the proposed xmpp.js family for inspection; keep the guard closed until revalidation.
3. Inspect every coupled owner above and all import sites, including dependency ranges and metadata/exports layouts.
4. Run the compatibility characterization and D1/D2/D5, redirects, STARTTLS, transport, SM, presence/subscriptions, Carbons, canonicalization and DM/MUC authorization regressions.
5. Explicitly update the validated version in `src/xmpp-runtime-compat.ts`, the reviewed import map, dependency pin/lockfile, fixtures and this inventory. Do not replace the assertion with a semver range.
6. Run `npm run test:packed-runtime` with an engine-valid Node/npm, as well as the full test/build/lint/format/audit/pack gates. This command builds and packs locally, installs disposable real consumers, verifies their supplied OpenClaw peer, and compares actual Node imports with the guard. It uses the public registry/cache and installs with scripts disabled; it publishes nothing.
7. Perform separately authorized field validation.
8. Release only after approval.

`test/xmpp-runtime-compat.test.ts` covers exact success, mismatches, metadata failures,
conditional exports, nested copies and symlink resolution. `test/xmpp-runtime-startup.test.ts`
proves ordering before registration, client creation and private adaptation.
The packed contract includes clean, compatible, conflicting and root-override
consumers, real plugin registration/client construction, no dev dependencies,
no nested OpenClaw runtime, and zero native xmpp.js loads on a rejected runtime.
