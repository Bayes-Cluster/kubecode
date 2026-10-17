# WeChat

[Documentation](../README.md) · [简体中文](../zh-CN/guides/wechat.md)

Kubecode can link one WeChat account so you can work with a Session from your
phone: send a prompt, follow the Agent's reply, answer permission questions,
and stop or redirect work. The Kubecode server talks to Tencent's iLink bot
service directly; the browser never contacts Tencent, and no Node.js or
OpenClaw installation is involved.

## Before you start

- The Kubecode server needs outbound HTTPS to Tencent's iLink hosts
  (`*.weixin.qq.com` and `*.wechat.com`). Kubecode refuses every other
  destination, including hosts that Tencent responses point to.
- You need a WeChat account that can scan bot-login QR codes. One WeChat
  account can be linked per Kubecode Runtime.
- Replies use your Kubecode server's language setting for channel messages:
  set `KUBECODE_ILINK_LANGUAGE=zh-CN` for Simplified Chinese (the default is
  English).

## Connect

1. Open **Settings → WeChat** and select **Connect WeChat**.
2. In WeChat, tap **+**, choose **Scan**, and scan the QR code. Codes refresh
   automatically a few times before expiring.
3. If WeChat shows a number, type it into **Verification code** and submit it.
   A number typed for an older QR code is rejected; use the current one.
4. The status changes to **Connected**. The WeChat user who scanned the code
   is the authorized contact.

The link survives server restarts. If WeChat later rejects the saved login, the
status shows **Login expired**; select **New QR code** to scan again.

## Choose the active Session

Messages from WeChat go to exactly one **active Session**. Choose it in
**Settings → WeChat → Active Session**, or use **Use for WeChat** in a Session's
menu in the sidebar. The active Session shows a WeChat marker in the sidebar.

Archived, read-only, Team, and sub-agent Sessions cannot be active. If the
active Session is archived or removed, the binding is cleared — Kubecode never
picks a replacement — and Settings explains what happened.

## Use it from WeChat

- **Prompts:** send text, a voice message with WeChat's transcription, or an
  image. A busy Session queues text prompts. Images are sent only when the
  Session is idle and its Agent accepts images; otherwise you get a short
  explanation.
- **Replies:** the Agent's text arrives in readable chunks of at most 2,000
  characters, flushed before tool calls and at the end of the turn, with a
  typing indicator while the Agent works. Very long replies are truncated with
  a note; the full reply is always in Kubecode.
- **Files:** when an Agent explicitly shares a file from the Session's Project
  (images, PDF, text, Markdown, CSV, JSON, ZIP, and Office documents up to
  10 MiB), it arrives as an image or attachment. Model text is never treated as
  a file path.
- **Permissions:** permission questions arrive as a numbered list. Reply with
  the number to choose. Only the options the Agent offered are accepted, and
  WeChat never widens the Session's permission profile.

### Commands

Commands start at the beginning of a message with `!` or `！`. Every command
first stops the active Session's current run.

| Command | Action |
| --- | --- |
| `!` | Show status: Session, Project, Agent, mode/model, run and queue state |
| `!s` | Switch the active Session (`!s 2` for the next page) |
| `!n` | Create a Session: choose a Project, then an Agent |
| `!m` | Change the Session's model or mode while it is idle |
| `!q` | Send a quick prompt |

Reply with the number shown in a menu. Menus expire after two minutes and
belong to the contact who opened them. Configure quick prompts in
**Settings → WeChat → Quick prompts**.

## Disconnect

**Settings → WeChat → Disconnect** asks for confirmation, then removes the
saved WeChat credentials, contacts, sync position, quick prompts, and the
active-Session choice from this Runtime. Sessions, provider history, and Project
files are never touched. Stopping the server keeps the link for the next start.

## Privacy and security

- Credentials and WeChat reply contexts are encrypted at rest with a
  machine-local key in the state directory (`ilink/secret.key`, readable only
  by the server user) and are deleted on disconnect.
- The browser receives connection status and a rendered QR image only — never
  tokens, QR identifiers, contact IDs, or Tencent responses.
- Logs, analytics, and workspace events never contain tokens, prompts, file
  names, file contents, or paths. Analytics record only the action and a
  categorical result.
- Only the authorized contact can drive the Session. Messages from anyone else
  receive a single "not available" reply and nothing else.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| **Connection error** right after Connect | Check outbound HTTPS from the server to `*.weixin.qq.com`, then try again. |
| **Verification blocked** | Too many wrong numbers. Select **New QR code**. |
| **Reconnecting** that does not settle | The server keeps retrying with backoff; check its network. **Reconnect** forces an immediate attempt after a short cooldown. |
| **Login expired** | WeChat rejected the saved login. Scan a **New QR code**. |
| WeChat says no Session is bound | Choose an active Session in Settings or with `!s`. |
| A shared file did not arrive | Only files inside the Session's Project, on the allowlist, and under 10 MiB are sent. Open the Session in Kubecode to get it. |
| No reply at all | WeChat allows replies only to contacts who recently wrote to the bot; send any message to refresh the conversation. |
