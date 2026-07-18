# 配置

[文档首页](../README.md) · [English](../../guides/configuration.md)

## Server Environment

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Server Bind Address |
| `PORT` | `8888` | HTTP 与 WebSocket Port |
| `NB_PREFIX` | 本地为空，镜像中为 `/` | Kubeflow Base Path |
| `PERSISTENT_DIR` | `/home/jovyan/srv` | 默认 Project 与持久化数据 Root |
| `KUBECODE_STATE_DIR` | `$PERSISTENT_DIR/.state/kubecode` | SQLite 与 Kubecode 私有状态 |
| `KUBECODE_STATIC_DIR` | `dist` | 构建后的 Web Asset |
| `KUBECODE_INTERNAL_ORIGIN` | Loopback Server URL 加 `NB_PREFIX` | 本地 Agent 访问 Team MCP 的 URL |

只有 Agent Process 无法通过默认 Loopback Origin 访问 Server 时，才需要设置
`KUBECODE_INTERNAL_ORIGIN`。它必须保持为内部、带认证的路由。

Agent Discovery Override 参见
[安装与部署](installation.md#agent-发现)。

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

## Base Path

将 `NB_PREFIX` 设置为 Kubeflow 暴露 Notebook 的完整路径，例如：

```text
/user/alice/kubecode
```

不要添加结尾 Slash。HTTP、SSE、Static Asset、Team MCP 和 Terminal WebSocket
URL 都从该 Prefix 派生。
