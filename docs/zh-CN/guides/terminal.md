# Terminal 与 TUI Session

[文档首页](../README.md) · [English](../../guides/terminal.md)

Kubecode 在底栏中提供可重连的 Project Terminal。Terminal 可以运行普通 Shell，
也可以运行 Claude Code、Codex 或 OpenCode 的原生 TUI。

## 创建与管理 Terminal

打开底栏后，可以：

- 创建 Shell 或 Agent TUI；
- 在侧边列表中切换 PTY；
- Rename 或 Close Terminal；
- 水平或垂直 Split 当前 Terminal；
- 调整 Split Pane 和整个底栏；
- 切换 Project 或 Session 后重连到仍在运行的 PTY。

Terminal 属于 Project，而不是当前选中的 Agent Session。在相同 Project 内切换
Session 不应该新建 Terminal。

## Split 行为

每个 Terminal Group 保存一棵 Split Tree。Panel Header 与 Outer Chrome 保持
简洁，但 Split Divider 始终可见并可拖动。Pane Ratio 不限制为固定比例。

关闭 Pane 会折叠它的 Parent Split。关闭最后一个 PTY 会关闭 Terminal Group，
底栏也可以随之折叠。

## Process Exit

输入 `exit` 或按 `Ctrl+D` 会结束 Shell。Kubecode 收到 Process Exit Event 后会
关闭对应 PTY Entry，而不是保留一个冻结的 Terminal Tab。

Agent TUI 遵循相同生命周期。认证与交互命令由 Agent CLI 实现，不由 Kubecode
实现。

## 持久化边界

Rust Server 存活期间，Kubecode 可以把 Browser View 重新连接到 PTY。Server 或
Notebook Pod 重启后，Terminal Process 和 Scrollback 不再保留。Agent 对话持久
化与 Terminal 分离，由 Session Store 和 Provider History 继续保存。

## Theme 与 Font

Terminal Color 跟随选中的 Kubecode Theme。Terminal Font 可以在
**Settings → General → Appearance** 中独立配置；该字体需要安装在用户的
Browser 环境中。
