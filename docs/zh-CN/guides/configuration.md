# 配置

[文档首页](../README.md) · [English](../../guides/configuration.md)

## Server 配置

Command-line Option 优先于当前 Environment Variable；当前变量优先于废弃的
兼容变量。

| Option | Environment | 默认值 | 用途 |
| --- | --- | --- | --- |
| `--host` | `KUBECODE_HOST` | `127.0.0.1` | Server Bind Address |
| `--port` | `KUBECODE_PORT` | `8888` | HTTP 与 WebSocket Port |
| `--base-path` | `KUBECODE_BASE_PATH` | `/` | 可选 Reverse Proxy Path |
| `--workspace-root` | `KUBECODE_WORKSPACE_ROOT` | `$HOME` | Directory Picker Root |
| `--state-dir` | `KUBECODE_STATE_DIR` | `$XDG_DATA_HOME/kubecode` 或 `$HOME/.local/share/kubecode` | SQLite 与私有状态 |
| — | `KUBECODE_STATIC_DIR` | `dist` | 构建后的 Web Asset；Standalone Launcher 会自动配置 |
| — | `KUBECODE_INTERNAL_ORIGIN` | Loopback Server URL 加 Base Path | 本地 Agent 访问 Team MCP 的 URL |

只有 Agent Process 无法通过默认 Loopback Origin 访问 Server 时，才需要设置
`KUBECODE_INTERNAL_ORIGIN`。它必须保持为内部、带认证的路由。

`HOST`、`PORT`、`NB_PREFIX` 和 `PERSISTENT_DIR` 暂时作为旧安装的废弃
Fallback。它们影响启动时，Kubecode 会输出迁移提示。

Agent Discovery Override 参见
[安装](installation.md#agent-发现)。

## Appearance

Settings 包含：

- System、Light 或 Dark Color Scheme；
- OpenCode-compatible Theme Preset；
- 12–20 像素的 UI Font 和 UI Font Size；
- Code Font；
- Terminal Font。

Appearance Setting 保存在 Browser Local Storage。Font Name 引用 Browser 环境
中已经安装的字体；Kubecode 不上传或分发自定义字体。

## Notification

System/Browser Notification 可以设为 Off、仅 Unfocused Window 或 Always。
Completion、Attention 和 Error 可以单独配置 System Sound 或 No Sound。

Browser 必须授予 Notification Permission。修改后可以点击 **Send test**。
应用内 Info、Warning、Error 和 Debug Message 不依赖 Browser Notification
Permission。

## Editor 与 Agent Preference

Editor Setting 包含 Auto Save。Agent Setting 包含是否允许用户直接在 Teammate
Chat 中输入；默认关闭，以保持 Team Communication 由 Leader 管理。

这些 Preference 保存在 Browser。Server 管理的 Project、Session、Team 和
Terminal State 不保存在 Browser Preference 中。

## Network 与 Base Path

Kubecode 暂不提供内置认证，因此默认监听 Loopback。任何 Non-loopback
Listener 都必须由带认证的 Reverse Proxy 保护。

使用 Path-based Proxy 时设置通用 Base Path：

```text
KUBECODE_BASE_PATH=/research/kubecode
```

不要添加结尾 Slash。HTTP、SSE、Static Asset、Team MCP 和 Terminal WebSocket
URL 都从该 Prefix 派生。
