# Contributing

Contributions should preserve the channel's minimal, text-only and fail-closed
baseline.

## Setup

The priority target is OpenClaw 2026.10.5. Use a Node.js version supported by
the selected host; the compatibility checks use Node.js 24.22.0 and npm 11.19.1
on Linux. The repository lockfile supplies SDK 2026.8.2 for reproducible builds.
See the [compatibility scope](README.md#installation) before choosing another
host. Local automated checks do not require a live XMPP account.

```bash
git clone https://github.com/Programmatore-Web/openclaw-xmpp-channel.git
cd openclaw-xmpp-channel
npm ci --ignore-scripts
npm run build
npm test -- --run --maxWorkers=1
```

Use only fictitious generic JIDs such as `bot@example.com`,
`user@example.com`, and `room@conference.example.com` in source, logs,
documentation, fixtures, and review notes.
Account and agent fixtures must also be generic, for example `primary`,
`secondary`, `account-a` or `agent-a`; retain `main` when testing an OpenClaw
convention. Do not copy identifiers from an operator's installation.

## Baseline constraints

- Keep DM and group defaults fail-closed.
- Authorize inbound senders before routing, session recording, model dispatch,
  commands, or tools.
- Treat a missing real MUC sender JID as unauthorized under group allowlist
  policy.
- Join only rooms explicitly listed in `groups`.
- Do not approve presence subscriptions or accept room invitations implicitly.
- Do not add local-file access, remote-content fetching, or file transfer to a
  general text-message change.
- Keep optional protocol work isolated and dependency-light.

## Source layout

```text
index.ts                 Plugin entry point and public exports
src/channel.ts           OpenClaw channel adapters
src/monitor.ts           XMPP connection and stanza lifecycle
src/inbound.ts           Authorization, routing, and reply delivery
src/outbound.ts          Text and presence sending
src/muc-identity.ts      Verified MUC occupant JID cache
src/rooms.ts             Explicit room join handling
src/stanza-handlers.ts   Presence and MUC self-presence handling
src/reconnect.ts         Bounded exponential-backoff reconnect
src/keepalive.ts         XEP-0199 keepalive
src/chat-state.ts        XEP-0085 and XEP-0333 helpers
src/replies.ts           XEP-0461 and XEP-0428 helpers
src/actions.ts           Optional XEP-0444 reactions
src/config-schema.ts     Runtime channel schema
src/accounts.ts          Single- and multi-account resolution
```

## Before submitting

```bash
npm ci --ignore-scripts
npm run build
npm test -- --run --maxWorkers=1
npm audit --omit=dev --omit=peer
npm pack --dry-run
git diff --check
```

The test suite must pass. Run `npm run lint` as an informational check and
report legacy lint configuration failures separately rather than broadening an
otherwise focused change.

Do not include credentials, private infrastructure details, generated package
archives, `dist/`, or `node_modules/` in a change.

## License

Contributions are licensed under the MIT License.
