# OpenClaw XMPP Channel

A minimal text-only XMPP channel plugin for OpenClaw.

## Features

- XMPP client connections over TCP, with STARTTLS required before authentication
- One-to-one and explicitly configured MUC text messaging
- Inbound/outbound OpenClaw routing and multi-account configuration
- Exponential-backoff reconnect, XEP-0198 when exposed by the client, and XEP-0199 keepalive
- XEP-0280 Message Carbons for correct self-message handling
- XEP-0461 replies with XEP-0428 fallback text
- XEP-0085 chat states and optional XEP-0333 read markers
- Optional XEP-0444 reactions without extra runtime dependencies
- Pairing and fail-closed allowlists for direct and group messages
- XEP-0066 inbound URLs exposed only as text; the plugin never fetches them

This baseline supports text only. It does not read local files, download remote
content, upload files, or provide application-layer end-to-end encryption.

## Installation

```bash
git clone https://github.com/Programmatore-Web/openclaw-xmpp-channel.git
cd openclaw-xmpp-channel
npm ci --ignore-scripts
npm run build
```

Register the built plugin using the normal OpenClaw extension configuration.

Supported runtimes: OpenClaw 2026.8.2 or newer within the 2026 release line,
and the Node.js ranges supported by OpenClaw 2026.8.2: 22.22.3–22.x,
24.15.0–24.x, or 25.9.0 and newer.

The validated xmpp.js runtime family is **exactly 0.14.0**. The plugin pins
`@xmpp/client` and locally verifies the actual upstream component copies before
loading their runtime or using private internals. Future semver-compatible versions
require revalidation; mismatched or unverifiable installations fail startup with
an actionable compatibility error. See [runtime policy and upgrade procedure](XMPP-RUNTIME-COMPATIBILITY.md).

## Configuration

```json
{
  "channels": {
    "xmpp": {
      "jid": "bot@example.com",
      "password": "replace-with-a-secret",
      "server": "example.com",
      "port": 5222,
      "nickname": "bot",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "allowFrom": ["user@example.com"],
      "groupAllowFrom": ["user@example.com"],
      "groups": ["room@conference.example.com"],
      "actions": {
        "reactions": false
      },
      "sendReadReceipts": true
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable or disable the account |
| `name` | none | Optional account display name |
| `jid` | required | Bot JID, for example `bot@example.com` |
| `password` | required | XMPP account password |
| `server` | JID domain | Physical TCP connection host; it does not replace the logical XMPP domain extracted from `jid` |
| `port` | `5222` | TCP client port; STARTTLS is required before authentication |
| `resource` | generated | Unique XMPP resource |
| `nickname` | JID local part | Nickname used in configured rooms |
| `dmPolicy` | `pairing` | `disabled`, `pairing`, `allowlist`, or explicit `open` |
| `groupPolicy` | `allowlist` | `allowlist` or explicit `open` |
| `allowFrom` | `[]` | Owner JIDs; an empty list grants no access |
| `dmAllowlist` | `[]` | Additional JIDs admitted by DM `allowlist` mode |
| `groupAllowFrom` | `allowFrom` | Real sender JIDs admitted in MUCs; an empty effective list grants no access |
| `groups` | `[]` | Exact room JIDs the account may join and process |
| `groupSettings` | none | Per-room mention and tool policies |
| `actions.reactions` | `false` | Enable XEP-0444 reactions |
| `sendReadReceipts` | `true` | Send XEP-0333 displayed markers for authorized DMs |

### Control UI

The plugin publishes `channelConfigs.xmpp` schema and UI hints for OpenClaw
2026.8.2's native **Settings → Channels** surface. Normal single-account and
named-account fields are represented by the schema-driven form, including
sensitive password fields and the optional physical `server` connect host. No
custom UI is required.

Fields present under a named `accounts` entry override the corresponding root
setting; omitted fields inherit it. The 2026.8.2 UI can normally edit these
values. Raw JSON or the CLI may still be needed for inheritance edge cases,
such as removing an enum override or distinguishing and restoring an omitted
array versus an explicitly empty array.

### Direct-message policy

- `pairing` is the default. Unknown senders receive an OpenClaw pairing code;
  their message is not routed to a model or session.
- `allowlist` admits owners and JIDs in `dmAllowlist`.
- `disabled` admits owners only.
- `open` admits any direct sender and must be configured explicitly.

Pairing approvals use OpenClaw's account-scoped pairing store. A paired peer
may use the conversation, but `CommandAuthorized` remains false for that peer.
Only static owners in `allowFrom` receive `CommandAuthorized: true`.

### MUC policy and verified identity

The plugin joins and processes only room JIDs listed in `groups`. Invitations
are ignored and never change that list. With the default `groupPolicy:
"allowlist"`, the room must expose each occupant's real JID in XEP-0045
presence. If the real JID is absent, stale, or not allowlisted, the message is
dropped before session creation or model/tool dispatch.

`groupPolicy: "open"` is still available as an explicit opt-in for configured
rooms, including rooms where real occupant JIDs are unavailable.

Presence subscriptions are approved only for explicit owners in `allowFrom`,
`presenceAllowFrom` viewers, or account-scoped pairing-approved JIDs. DM and group
policies do not grant presence access. Subscriptions are not reciprocated.

### Agent presence in Thunderbird

| Agent state | XMPP presence | Thunderbird |
| --- | --- | --- |
| Available: connected and operational | Ordinary presence, no `show`, priority `1` | Available / Disponibile |
| Unavailable: connected but busy, blocked, or forced unavailable | `show=dnd`, priority `1`, no `type` | Unavailable / Non disponibile |
| Offline: no live XMPP session | Session/resource loss; graceful stop sends `type=unavailable` | Offline / Non in linea |

Operational unavailable **keeps the session online**. Offline is never a cosmetic
mode. If another resource for the same JID remains online, Thunderbird can still
show that resource's presence.

```json
{
  "channels": {
    "xmpp": {
      "jid": "agent@example.com",
      "allowFrom": ["alice@example.com"],
      "presenceAllowFrom": ["bob@example.com"],
      "presence": {
        "mode": "auto",
        "availableText": "Ready",
        "unavailableText": "Temporarily unavailable"
      }
    }
  }
}
```

This fragment extends an account with credentials already configured.
`presence.mode` defaults to `auto`: `busy === true`, `activeRuns > 0`,
`ingressUnavailable === true`, or `lifecycle === "blocked"` selects unavailable;
otherwise the connected agent is available. Authorized XMPP reply/reaction runs
update OpenClaw's public run tracker. Status is sampled once per second, so runs
shorter than that may not appear busy. `available` and `unavailable` force the
operational state while connected. Neither can make a disconnected session online.

`presence.availableText` and `presence.unavailableText` are optional public text.
Only configured text is sent; runtime errors and internal reasons are never copied
into presence. Omit text to send none; an empty string removes inherited text.
Named accounts inherit each omitted presence field from the root. Their
`presenceAllowFrom` array replaces the root array when explicitly supplied.

`presenceAllowFrom` adds viewers without granting DM or command access. Owners
must be explicitly named in `allowFrom`; its wildcard does not make presence
public. Only an explicit `presenceAllowFrom: ["*"]` permits public presence.
`dmPolicy: "open"`, `dmAllowlist`, and `groupAllowFrom` do not grant presence access;
add those people to `presenceAllowFrom` when desired. Presence requests never
create pairing challenges. Pairing remains a DM flow.

At every fresh login, the plugin reads the server roster and revokes subscribers
no longer trusted, without deleting their contact entries. Failed reconciliation
suppresses global operational presence; messaging, configured MUC joins and trusted
directed replies remain usable. Config changes take effect through account reload.
After unpairing someone, reload the account to reconcile persistent subscriptions:
successful SM resumption retains the same logical session and does not reconcile
again. A server may retain a resumable session temporarily during network loss;
offline appears when that resource/session actually disappears.

This feature targets direct contacts in Thunderbird. Room-specific occupant
`show` updates are a follow-up; MUC authorization and join policy are unchanged.
See [presence design and SDK findings](AGENT-PRESENCE.md) for lifecycle details.

### Multi-account example

```json
{
  "channels": {
    "xmpp": {
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "accounts": {
        "primary": {
          "jid": "bot@example.com",
          "password": "replace-with-a-secret",
          "allowFrom": ["user@example.com"]
        },
        "secondary": {
          "jid": "bot2@example.com",
          "password": "replace-with-another-secret",
          "groups": ["room@conference.example.com"],
          "groupAllowFrom": ["user@example.com"]
        }
      }
    }
  }
}
```

## Supported extensions

| XEP | Support |
| --- | --- |
| XEP-0045 | Text MUCs explicitly listed in configuration |
| XEP-0066 | Inbound URL/description surfaced as text, without fetching |
| XEP-0085 | Chat state notifications |
| XEP-0198 | Stream Management when provided by `@xmpp/client` |
| XEP-0199 | Periodic keepalive ping |
| XEP-0280 | Message Carbons |
| XEP-0333 | DM displayed markers |
| XEP-0359 | Stable IDs used for reaction references |
| XEP-0428 | Fallback indication for replies |
| XEP-0444 | Optional message reactions |
| XEP-0461 | Reply pointers |

## Development checks

```bash
npm ci --ignore-scripts
npm run build
npm test -- --run
npm audit --omit=dev --omit=peer
npm pack --dry-run
git diff --check
```

## License

MIT
