# Configuration

[Documentation](../README.md) · [简体中文](../zh-CN/guides/configuration.md)

## Server environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `8888` | HTTP and WebSocket port |
| `NB_PREFIX` | empty locally, `/` in the image | Kubeflow base path |
| `PERSISTENT_DIR` | `/home/jovyan/srv` | Default Project and persistent-data root |
| `KUBECODE_STATE_DIR` | `$PERSISTENT_DIR/.state/kubecode` | SQLite and private Kubecode state |
| `KUBECODE_STATIC_DIR` | `dist` | Built web assets |
| `KUBECODE_INTERNAL_ORIGIN` | loopback server URL plus `NB_PREFIX` | URL used by local Agents to reach Team MCP |

`KUBECODE_INTERNAL_ORIGIN` is needed only when an Agent process cannot reach the
server through its default loopback origin. It must remain an internal,
authenticated route.

Agent discovery overrides are documented in
[Installation and deployment](installation.md#agent-discovery).

## Appearance

Settings include:

- system, light, or dark color scheme;
- OpenCode-compatible theme presets;
- UI font and UI font size from 12 to 20 pixels;
- code font;
- terminal font.

The browser stores appearance settings locally. Font names reference fonts
installed in the browser environment; Kubecode does not upload or distribute
custom font files.

## Notifications

System/browser notifications can be off, limited to unfocused windows, or
always enabled. Completion, attention, and error categories can be configured
independently, including system sound or no sound.

The browser must grant Notification permission. Use **Send test** after changing
the setting. In-app info, warning, error, and debug messages remain available
independently of browser notification permission.

## Editor and Agent preferences

Editor settings include auto-save behavior. Agent settings include whether a
user may type directly into teammate chats; this is disabled by default so Team
communication remains Leader-governed.

These preferences are browser-local. Server-owned Project, Session, Team, and
Terminal state is not stored in browser preferences.

## Base-path behavior

Set `NB_PREFIX` to the full path at which Kubeflow exposes the Notebook, for
example:

```text
/user/alice/kubecode
```

Do not add a trailing slash. HTTP, SSE, static assets, Team MCP, and Terminal
WebSocket URLs are derived from this prefix.
