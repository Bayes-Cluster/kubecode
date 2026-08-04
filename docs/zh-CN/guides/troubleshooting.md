# 故障排查

[文档首页](../README.md) · [English](../../guides/troubleshooting.md)

## Agent 不可用

打开 **Settings → Agents**，展开 Agent Diagnostic，并确认：

1. CLI Executable 存在，Kubecode Server User 有执行权限；
2. 可以通过 `PATH` 或显式 Discovery Override 找到；
3. CLI 可以在没有交互设置的情况下输出版本；
4. Claude 或 Codex ACP Adapter 显示为 Ready。

修复安装后点击 **重新检测**。刷新后的 Catalog 会由新建 Session、Team 和
Agent TUI Terminal 共享；已经连接的 Session 不会被中断。

也可以在 Shell 中运行：

```bash
kubecode doctor
kubecode doctor --json
```

Doctor 是无副作用检查：它会验证本地 Runtime Dependency，但不会创建 Provider
Session，也不会验证 Provider Authentication。

## ACP Connection Failed

Session 创建错误会指出失败发生在 Process Spawn、ACP Initialize，还是
Provider Session 的 New、Load 或 Resume 阶段。Authentication 和 Project
Directory 只能在这里检查，因为 Passive Doctor 无法安全地验证它们。

从相同 Project Directory 直接运行 Agent CLI，确认已经登录，然后运行可选的
Real-Agent Smoke Test。不要把 Provider Config 或 API Key 粘贴到 Issue 中。

对于 OpenCode Directory Failure，可以比较：

```bash
pwd
git rev-parse --show-toplevel
opencode acp --cwd "$PWD"
```

Project 必须仍然存在；Kubecode Project Record 必须解析到相同 Canonical
Directory；Server User 必须有访问权限。Team Member 应继承已解析的 Member
Workspace，不能使用 Null 或过期 Path。

## Reverse Proxy 页面或 WebSocket 失败

- 确认 `KUBECODE_BASE_PATH` 与外部公开的 Path 完全一致。
- 检查不带 Prefix 的 `/healthz` 和 `/readyz` Health Endpoint。
- 确认 Proxy 转发 WebSocket Upgrade。
- 确认 Proxy 对 Path 的移除或保留行为与 Server Base Path 一致。
- `KUBECODE_INTERNAL_ORIGIN` 只用于 Agent 访问 Team MCP。

## 重启后 Session 或 Team 状态过期

刷新页面一次，并查看应用内 Message Center。Kubecode 独立恢复 Project、
Session、Team 和 Status，一个请求失败不应该隐藏其他状态。

如果 Team 停留在 `needs_attention`，检查 Member Status、Pending Permission、
Blocked Task 和 Provider Limit。解决根因后再 Resume Team。

## Terminal 没有关闭

输入 `exit` 或按 `Ctrl+D` 后，检查 Shell Process 是否真的退出，还是仍在等待
Child Process。完成的 PTY 应从 Terminal List 消失。Server Log 应包含 Process
Exit Event，但不能记录 Terminal Content。

## Git Diff 不可用

确认选择的 Path 相对于 Project Root，并且仍存在于 Repository 中。重新打开
Diff 前先刷新 Git Status。Binary、超大或不支持的 Diff 是可恢复状态；适当
情况下选择更小的文本变更。Diff 加载失败可以从 Diff 视图重试。对于
Submodule、Rename 或特殊 Worktree State，报告 Kubecode Bug 前先用本地 Git
检查相同路径。

## Files 或 Git 过期

Watcher 是 best-effort 的 Invalidation 来源。Agent、Terminal、Git 或外部进程修改
文件后请等待短暂的 Coalescing Window；如果仍未出现，请使用 Explorer 的
Refresh Button。Watcher 安装或 Backend 失败不会禁用 Project：Kubecode 会重试，
成功后会执行一次完整的 Files 与 Git Reconciliation。Queue Overflow、无法分类的
Path 或漏掉的 Native Notification 也会走相同的 Full Recovery 流程。

Runtime Connection 显示 **Reconnecting** 或 **Resynchronizing** 时，浏览器会重新
打开 Durable SSE Stream，并在打开后刷新所有已加载的 Files Directory 和 Git Status。
此流程只使用 Project ID 与经过验证的 Relative Path，不会重放绝对 Server Path 或
File Content。Directory Error 会保留旧 Row 并标记为 Stale，直到 Manual Refresh
成功；Git Status Error、Status Truncated Warning 和 Unavailable Diff 都可以通过
Refresh 或 Diff Retry 恢复。

## Notification 没有出现

1. 在 Settings 中启用对应 Category；
2. 测试时选择 `Always`；
3. 授予 Browser Notification Permission；
4. 点击 **Send test**；
5. 检查 OS Focus 或 Do Not Disturb。

Browser Notification 被拒绝时，应用内 Message 仍然工作。

## 报告 Bug

请提供：

- Kubecode Commit；
- Browser、Linux Distribution 与 Architecture；
- Installation Method 和 `KUBECODE_BASE_PATH`；
- Agent Name 与 Version；
- 简洁的 Reproduction Step；
- 已移除 Credential、Path、Prompt、Filename 和 File Content 的相关日志。

安全漏洞必须遵循 [SECURITY.md](../../../SECURITY.md)。
