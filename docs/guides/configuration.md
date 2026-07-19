# Configuration

[Documentation](../README.md) · [简体中文](../zh-CN/guides/configuration.md)

## Server configuration

Command-line options take precedence over current environment variables, which
take precedence over deprecated compatibility variables.

| Option | Environment | Default | Purpose |
| --- | --- | --- | --- |
| `--host` | `KUBECODE_HOST` | `127.0.0.1` | Server bind address |
| `--port` | `KUBECODE_PORT` | `8888` | HTTP and WebSocket port |
| `--base-path` | `KUBECODE_BASE_PATH` | `/` | Optional reverse-proxy path |
| `--workspace-root` | `KUBECODE_WORKSPACE_ROOT` | `$HOME` | Directory picker root |
| `--state-dir` | `KUBECODE_STATE_DIR` | `$XDG_DATA_HOME/kubecode` or `$HOME/.local/share/kubecode` | SQLite and private state |
| — | `KUBECODE_STATIC_DIR` | `dist` | Built web assets; configured by the standalone launcher |
| — | `KUBECODE_INTERNAL_ORIGIN` | Loopback server URL plus the base path | URL used by local Agents to reach Team MCP |

`KUBECODE_INTERNAL_ORIGIN` is needed only when an Agent process cannot reach the
server through its default loopback origin. It must remain an internal,
authenticated route.

`HOST`, `PORT`, `NB_PREFIX`, and `PERSISTENT_DIR` remain temporary deprecated
fallbacks for existing installations. Kubecode prints a migration warning when
one affects startup.

Agent discovery overrides are documented in
[Installation](installation.md#agent-discovery).

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

## Network and base-path behavior

Kubecode has no built-in authentication and therefore binds to loopback by
default. Protect any non-loopback listener with an authenticated reverse proxy.

For a path-based proxy, set a generic base path:

```text
KUBECODE_BASE_PATH=/research/kubecode
```

Do not add a trailing slash. HTTP, SSE, static assets, Team MCP, and Terminal
WebSocket URLs are derived from this prefix.
