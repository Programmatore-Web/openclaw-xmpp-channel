# OpenClaw XMPP channel instructions

This repository provides a minimal, text-only XMPP channel for OpenClaw.

## Security invariants

- Require STARTTLS before sending authentication credentials.
- Default direct messages to `pairing` and groups to `allowlist`.
- Treat empty allowlists as denying access; only an explicit `*` is a wildcard.
- Authorize a sender before route resolution, session recording, model dispatch,
  commands, or tools.
- Under group allowlist policy, require the real bare JID supplied by XEP-0045
  presence. A missing or stale identity is unauthorized.
- Join and process only rooms explicitly listed in `groups`.
- Ignore room invitations and presence subscription requests.
- Do not add local-file reads, remote-content fetching, file transfer, or
  application-layer encryption as part of general channel work.

## Maintained surface

- TCP XMPP client connection, STARTTLS, and SASL authentication
- Direct and configured-MUC text messages
- OpenClaw inbound/outbound routing and multi-account configuration
- Reconnect, XEP-0198 Stream Management when supported by the client, and
  XEP-0199 keepalive
- XEP-0280 Message Carbons
- XEP-0461 replies with XEP-0428 fallback text
- XEP-0085 chat states and XEP-0333 read markers
- Optional, dependency-light XEP-0444 reactions
- XEP-0066 inbound URLs as text only, without fetching

## Source map

```text
index.ts                 Plugin entry point and public exports
src/channel.ts           OpenClaw channel adapters
src/monitor.ts           Connection and message-stanza lifecycle
src/inbound.ts           Authorization, routing, and reply delivery
src/outbound.ts          Text and presence sending
src/muc-identity.ts      Verified MUC occupant identity cache
src/rooms.ts             Explicit configured-room joins
src/stanza-handlers.ts   Presence handling
src/reconnect.ts         Reconnect policy
src/keepalive.ts         XEP-0199 keepalive
src/chat-state.ts        Chat states and read markers
src/replies.ts           Reply and fallback helpers
src/actions.ts           Optional reactions
src/config-schema.ts     Runtime configuration schema
src/accounts.ts          Account resolution
```

## Conventions

- Use bare, lowercase JIDs for authorization comparisons.
- Use OpenClaw's account-scoped pairing store for DM approvals.
- Use the provided logger rather than raw console output in new code.
- Keep protocol extensions isolated and dependency-light.
- Use only generic examples such as `bot@example.com`, `user@example.com`, and
  `room@conference.example.com`.

## Verification

```bash
npm ci --ignore-scripts
npm run build
npm test -- --run
npm audit --omit=dev --omit=peer
npm pack --dry-run
git diff --check
```

ESLint 9 needs a flat configuration before `npm run lint` can pass; keep that
debt separate from unrelated feature changes.
