---
type: ADR
id: "0211"
title: "Rust-owned WeChat iLink channel (protocol authority, durable state, trust boundary, bridge)"
status: proposed
date: 2026-08-31
---

## Context

Kubecode Sessions are currently reachable only through the browser or an
authenticated Runtime client. Users who leave the browser need a lightweight
way to send a prompt to an existing Session, follow Agent responses, answer
interactive questions, and stop or redirect work from a phone.

Tencent's MIT-licensed [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
repository implements a WeChat channel plugin for the OpenClaw platform. It is
a TypeScript package with an OpenClaw peer dependency. Kubecode is a standalone
Rust/Axum Runtime whose Linux distribution must not acquire a Node.js or
OpenClaw sidecar. [Fello](https://github.com/Zythum/fello) demonstrates the
product flow but uses a simplified protocol client that omits versioned iLink
headers, QR redirect states, sync-cursor persistence, context-token isolation,
retry/backoff, encrypted CDN media, and session guards.

The Tencent repository is therefore the **normative protocol and behavior
authority**. Kubecode ports the required channel protocol into a Rust-owned
service with fixture and behavior parity tests. Fello is a product-flow
reference only — its source code is never copied or depended upon.

### Upstream compatibility baseline

The protocol contract is pinned to Tencent/openclaw-weixin at the following
reviewed commit:

| Field | Value |
| --- | --- |
| Repository | `Tencent/openclaw-weixin` |
| Branch | `main` |
| Review date | 2026-08-31 |
| Plugin version line | 2.0.x |
| Key source modules reviewed | `src/api/`, `src/auth/`, `src/cdn/`, `src/messaging/`, `src/storage/`, `src/channel.ts` |

Future upstream compatibility reviews are recorded as dated addenda to this
ADR. A protocol-level change in the upstream repository (new login state,
header field, or business code) requires a review addendum before Kubecode
adopts it.

## Decision

### 1. Protocol authority and native Rust ownership

Tencent's `openclaw-weixin` is the **protocol authority**: it defines the
iLink HTTP/JSON endpoints, header fields, login states, long-poll semantics,
sync-cursor management, CDN upload/download, and business return codes.
Kubecode implements a native Rust HTTP client (`ILinkClient`) that speaks the
same wire protocol, validated by fixture tests against recorded upstream
responses.

The TypeScript/OpenClaw plugin is used as a **protocol and behavior reference**
only. It is never embedded, spawned, or installed at runtime. The standalone
Linux artifact requires neither Node.js, OpenClaw, nor an `openclaw-weixin`
installation.

The `ILinkService` is a Rust-owned background service owned by `AppState`.
It supervises all iLink HTTP tasks, manages reconnect/backoff, handles
graceful shutdown, and exposes a narrow internal API to the REST layer and
the workspace event bus.

### 2. Single-account product model

The first release supports **one linked WeChat account per Kubecode
instance**. The SQLite schema still keys all channel state by a stable
`account_id` (not by device or peer) so that multi-account support in a
future ADR does not require a migration.

Tables:

```sql
CREATE TABLE IF NOT EXISTS ilink_accounts (
    account_id   TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'disconnected',
    created_at   TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE TABLE IF NOT EXISTS ilink_credentials (
    account_id  TEXT PRIMARY KEY REFERENCES ilink_accounts(account_id),
    context_token TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    committed_cursor INTEGER NOT NULL DEFAULT 0,
    encrypted_blob BLOB NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE TABLE IF NOT EXISTS ilink_peers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   TEXT NOT NULL REFERENCES ilink_accounts(account_id),
    peer_id      TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    context_token TEXT,
    UNIQUE(account_id, peer_id)
);

CREATE TABLE IF NOT EXISTS ilink_inbound_dedupe (
    account_id  TEXT NOT NULL REFERENCES ilink_accounts(account_id),
    message_key TEXT NOT NULL,
    seen_at     TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'now')),
    PRIMARY KEY (account_id, message_key)
);

CREATE TABLE IF NOT EXISTS ilink_session_binding (
    account_id          TEXT PRIMARY KEY REFERENCES ilink_accounts(account_id),
    conversation_id     TEXT NOT NULL REFERENCES conversations(id),
    bound_at            TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'now'))
);
```

### 3. Credential-at-rest handling

iLink credentials (`context_token`, `device_id`, and any session cookies) are
encrypted at rest using AES-256-GCM with a key derived from a machine-local
secret stored in a dedicated file at `<state>/ilink/secret.key` (0600,
generated on first login, never backed up or transmitted). The encrypted blob
is stored in `ilink_credentials.encrypted_blob`.

On logout, the credential row and the secret file are deleted. On process
stop (without logout), credentials and cursor survive for automatic
restoration on restart.

File permissions: the state directory and all iLink files are 0700/0600.
SQLite WAL files inherit the database file permissions. Secret deletion on
logout is atomic (delete file, then delete row).

Startup restoration: if `ilink_credentials` has a row and the secret file
exists, the service attempts automatic reconnection using the stored
credentials. If the credentials are expired or rejected by Tencent, the
account transitions to `expired` and the user must re-scan the QR code.

### 4. Service lifecycle

`ILinkService` is owned by `AppState` and supervised as a tokio task. The
service manages:

- A long-poll sync loop that polls Tencent for inbound messages using the
  committed cursor and server-suggested timeouts.
- An outbound send queue for WeChat messages (text, typing state, media).
- A QR login flow that polls the login endpoint and transitions through
  `wait` → `scaned` → `confirmed` (or `expired`, `scaned_but_redirect`,
  `need_verifycode`, `verify_code_blocked`, `binded_redirect`).
- Cancellation via a `CancellationToken` per task.
- Bounded transport retries with exponential backoff (base 1s, max 60s,
  jitter). Reconnects attempt credential restoration before re-authentication.

Graceful shutdown: `ILinkService::shutdown()` cancels all tasks, drains the
outbound queue, persists the current sync cursor, and closes HTTP connections.
The `DROP` handler on `AppState` triggers this via a `CancellationToken`.

The REST API exposes `notifyStart` and `notifyStop` endpoints that control
the service lifecycle without requiring a Runtime restart.

### 5. REST and status surface

All iLink REST routes live under `/api/v1/ilink/` and respect the configured
generic base path. Browser payloads never contain tokens, context tokens, QR
material, or raw upstream data.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/ilink/status` | Account status, session binding, connection state |
| `POST` | `/ilink/login/qr` | Start QR login; returns QR image data (SVG data URI) |
| `GET` | `/ilink/login/qr/poll` | Poll current login state |
| `POST` | `/ilink/logout` | Disconnect and delete credentials |
| `PUT` | `/ilink/session-binding` | Bind or rebind a Session |
| `DELETE` | `/ilink/session-binding` | Unbind the current Session |

The workspace event bus carries `ilink_status_changed` events (connection
state, account display name, session binding) so the browser updates without
polling. These events never carry credentials or message content.

### 6. Inbound idempotency and cursor commit order

Each inbound iLink message carries a stable message key (sender + timestamp +
sequence). The journal:

1. Checks `ilink_inbound_dedupe` for the message key; if present, drops the
   message.
2. Processes the message (run admission, prompt submission, or command).
3. On success, inserts the message key into `ilink_inbound_dedupe` and
   advances the committed cursor in `ilink_credentials` in the same
   transaction.

This ensures that retries (transport or process) cannot duplicate a prompt,
and that a received message is never skipped. The cursor is committed only
after the message is fully processed.

### 7. Peer authorization and context-token isolation

Each WeChat peer is identified by a stable `peer_id` (WeChat user id).
Interactive state (pending command menu, permission card, elicitation) is
keyed by `(account_id, peer_id)`. One sender cannot answer another sender's
menu or permission request.

The first peer to message the linked account after login is authorized
automatically. Additional peers require explicit authorization from the
Settings UI. Unauthorized peers receive a localized rejection message.

Context tokens from Tencent are stored per `(account_id, peer_id)` in
`ilink_peers.context_token` and never shared across peers.

### 8. Run admission and outbound reply derivation

Inbound WeChat text messages enter the existing run admission path via
`AgentRuntime::start_or_queue`. The prompt text is the message body. The
client_message_id is derived from the message key for idempotency. Queue
semantics (#95) apply: if a run is active, the prompt queues durably.

Agent replies are derived from the authoritative normalized session event
stream — the same events the browser consumes. `ILinkService` subscribes to
the workspace event bus for the bound conversation, filters for
`text_delta`, `tool_started`, `tool_completed`, `run_completed`,
`subagent_update`, and `conversation_state` events, and buffers them for
outbound delivery.

Buffered output flushes at useful boundaries:
- Turn/tool boundaries (tool_started → tool_completed transitions)
- 2,000-character chunks (WeChat practical limit)
- Terminal events (`run_completed` with any typed cause)
- Explicit `!q` interruption

Each flush sends a WeChat text message to the originating peer via
`ILinkClient`. Typing state is sent before the first text chunk.

### 9. Remote permission and elicitation handling

When the bound conversation has a pending permission or elicitation request,
`ILinkService` sends a formatted message listing the options (numbered 1–N).
The peer can reply with a number to select an option.

Permission and elicitation answers accept **only** currently advertised
options from the pending request payload. WeChat never enables Maximum/YOLO/
Allow All automatically. The bound Session keeps its existing permission
profile.

Answers expire with the Runtime's existing pending-request contract
(`KUBECODE_PENDING_REQUEST_TIMEOUT_MS`). Expired requests receive a
localized "expired" message.

### 10. Media handling

Inbound images: downloaded to a bounded temporary file at
`<workspace>/tmp/ilink/{sha256}.{ext}` (content-typed, max 10 MiB). The file
path is attached to the prompt as a validated context reference through
`WorkspaceService`. Temporary files are cleaned up after the run completes.

Inbound voice: if Tencent provides a transcription field, the transcription
is used as text. Otherwise, an explicit localized "voice not supported"
response is sent.

Outbound media: if the Agent produces an image, it is uploaded to Tencent's
encrypted CDN via the iLink media endpoint and sent as a WeChat image message.
Files are bounded (max 10 MiB) and content-typed.

All temporary files are cleaned up deterministically after the run or on
service shutdown. Filesystem access stays behind `WorkspaceService`.

### 11. Host validation and SSRF prevention

All Tencent endpoint URLs (base, redirect, CDN) are validated against an
allowlist of `.qq.com` and `.wechat.com` suffixes before any HTTP request.
Upstream URLs from login redirects or CDN responses are never used as a
destination for subsequent requests unless they pass this validation.

HTTP responses are checked for both HTTP status codes and iLink business
return codes (JSON `ret` field). Non-zero business codes are treated as
errors with localized user-facing messages.

### 12. Redaction and diagnostics

Logs, analytics, diagnostics, and public workspace-event payloads never
contain:
- Tokens, context tokens, or session cookies
- QR payloads or login material
- Message bodies or prompt content
- Filenames or file contents
- Absolute paths
- Media data or URLs
- Raw upstream payloads

Connection state logs carry only: account display name, status string,
conversation binding, and timestamp. Error logs carry only the error kind
and iLink business code, never the raw response body.

### 13. Active-Session binding validation

The bound Session is validated on every inbound message:
- Must exist and not be archived
- Must be writable (`read_only` false, not a Team discriminator, not in a
  historical revision view)
- Must belong to a registered Project
- Must not be a sub-agent conversation

If the bound Session is deleted or becomes unwritable, the binding is
cleared and a localized "Session no longer available" message is sent to
the peer. The user must rebind from Settings before further messages are
processed.

### 14. First-release non-goals

- Multiple linked WeChat accounts
- Group-chat semantics
- Proactive broadcast/marketing messages
- Cron delivery or scheduled prompts
- Arbitrary outbound messages without a valid peer context
- Voice message synthesis (outbound voice)

These are deferred to a future ADR. The schema and service design do not
preclude them.

### 15. Relationship to existing ADRs

This ADR does not weaken:
- ADR 0161 (web server boundary): iLink routes live under the existing
  Axum router with base-path support.
- ADR 0164 (session actors and global events): inbound WeChat messages
  enter the existing run admission path; outbound replies derive from the
  workspace event bus.
- ADR 0200 (authenticated headless Runtime): iLink credentials are
  separate from Runtime auth tokens.
- ADR 0201 (authenticated headless Runtime clients): WeChat is a
  notification channel, not a Runtime client.
- ADR 0204 (bounded Tokio ACP session actors): iLink does not create
  additional ACP actors; it uses the existing session actor pool.
- ADR 0205 (durable wake-driven workspace event delivery): iLink subscribes
  to workspace events via the existing bus.
- ADR 0206 (typed composer catalog and structured draft): iLink prompts are
  plain text; structured drafts are not exposed through WeChat.
- ADR 0210 (agent interaction model): inbound WeChat messages enter
  `start_or_queue`; outbound replies derive from the same event stream the
  browser consumes; permission handling uses the existing pending-request
  contract.

## Consequences

- The Rust server gains an `ILinkService` with SQLite persistence for
  channel state and a new REST surface under `/api/v1/ilink/`.
- The web client gains a WeChat Settings panel (QR, status, binding) that
  consumes the new REST surface and the existing workspace event stream.
- The standalone Linux artifact gains no new runtime dependencies (no
  Node.js, no OpenClaw, no openclaw-weixin package).
- The session-event table gains no iLink rows; iLink state lives in its own
  tables.
- Users can collaborate with Sessions from WeChat with full security
  guarantees: no permission escalation, no credential exposure, no
  cross-peer leakage, no SSRF surface.
