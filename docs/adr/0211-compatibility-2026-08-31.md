# ADR 0211 compatibility note — 2026-08-31

Upstream compatibility baseline for the Rust iLink channel implementation
(issue #125). This note is a dated addendum to ADR 0211, which designates
Tencent's `openclaw-weixin` as the normative protocol authority.

## Reviewed upstream revision

| Field | Value |
| --- | --- |
| Repository | `Tencent/openclaw-weixin` |
| Branch | `main` |
| Reviewed commit | `cef0bfc390393f716903e16d50408118047f87e0` |
| Commit date | 2026-06-25 |
| Package version | `2.4.6` |
| Modules reviewed | `src/api/api.ts`, `src/api/types.ts`, `src/auth/login-qr.ts`, `src/cdn/*`, `src/storage/sync-buf.ts`, `src/messaging/inbound.ts`, `src/messaging/send.ts`, `src/util/redact.ts` |

## Covered endpoints

| Endpoint | Method | Kubecode entry point |
| --- | --- | --- |
| `ilink/bot/get_bot_qrcode?bot_type=3` | POST (no bearer) | `IlinkClient::create_qr` |
| `ilink/bot/get_qrcode_status?qrcode=…[&verify_code=…]` | GET, long-poll | `IlinkClient::poll_qr_status` |
| `ilink/bot/getupdates` | POST, long-poll | `IlinkClient::get_updates` |
| `ilink/bot/sendmessage` | POST | `IlinkClient::send_message` |
| `ilink/bot/getconfig` | POST | `IlinkClient::get_config` |
| `ilink/bot/sendtyping` | POST | `IlinkClient::send_typing` |
| `ilink/bot/msg/notifystart` | POST | `IlinkClient::notify_start` |
| `ilink/bot/msg/notifystop` | POST | `IlinkClient::notify_stop` |
| `ilink/bot/getuploadurl` | POST | `IlinkClient::get_upload_url` |
| CDN `upload` / `download` | POST / GET | `CdnClient` |

## Covered wire fields and constants

- Headers: `AuthorizationType: ilink_bot_token`, `Authorization: Bearer …`
  (only when a token is set), `X-WECHAT-UIN` (random uint32 → decimal →
  base64, per request), `iLink-App-Id` (`bot`, upstream `ilink_appid`),
  `iLink-App-ClientVersion` (uint32 `0x00MMNNPP` of the channel version).
- Body envelope: `base_info: { channel_version, bot_agent }` on every CGI
  request; `bot_agent` sanitized with the upstream UA-token grammar and the
  256-byte cap (Kubecode default `kubecode/<version>`).
- Login states: `wait`, `scaned`, `confirmed`, `expired`,
  `scaned_but_redirect`, `need_verifycode`, `verify_code_blocked`,
  `binded_redirect` — all represented; unknown states are typed protocol
  errors.
- Sync: opaque `get_updates_buf` carried across requests and persisted
  durably (#126); `longpolling_timeout_ms` honored as the next long-poll
  bound; `errcode -14` maps to the typed session-expired error.
- CDN: `getuploadurl` response fields (`upload_param`,
  `thumb_upload_param`, `upload_full_url`), `/upload` fallback with
  `encrypted_query_param` + `filekey`, `x-encrypted-param` download
  parameter, `/download?encrypted_query_param=…` fallback, AES-128-ECB with
  PKCS#7 (`filesize = floor(n/16)*16 + 16`), and both wild `aes_key`
  encodings (base64 of 16 raw bytes; base64 of a 32-char hex string).
- Timeouts: long poll 35 s, regular API 15 s, lightweight 10 s; long-poll
  timeout and cancellation are control flow, not errors.
- Redaction: tokens, context tokens, typing tickets, AES keys, and QR ids
  are typed as `Secret` (redacting `Debug`/`Display`); URL query strings
  and sensitive JSON fields are masked in diagnostics; errors carry only
  the operation name and business code.

## Deliberate Kubecode differences

- `channel_version` reports the Kubecode server version, not the upstream
  package version; `bot_agent` defaults to `kubecode/<version>`.
- The fixed QR base (`https://ilinkai.weixin.qq.com`) and every other
  destination must pass the `.qq.com` / `.wechat.com` HTTPS allowlist
  before any request — including upstream-supplied `baseurl`,
  `redirect_host`, and CDN `full_url` values.
- `SKRouteTag` is not sent (no route-tag configuration exists in Kubecode).
- The ADR 0211 schema sketch's plaintext `context_token` columns are
  realized as AES-256-GCM sealed blobs (`ilink_credentials.sealed_blob`,
  `ilink_peers.sealed_context_token`) because §3 supersedes the sketch:
  no plaintext credential column is ever persisted. The opaque
  `get_updates_buf` (the actual upstream sync cursor) is persisted
  alongside `committed_cursor`, which counts committed messages for
  diagnostics.
- Wire test fixtures are committed under `server/tests/ilink_fixtures/`
  with synthetic tokens, user ids, and message bodies only.
