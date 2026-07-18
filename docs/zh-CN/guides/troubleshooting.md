# 故障排查

[文档首页](../README.md) · [English](../../guides/troubleshooting.md)

## Agent 不可用

打开 Agent Picker 或 Settings 查看 Discovery Diagnostic，并确认：

1. CLI Executable 存在，Notebook User 有执行权限；
2. 可以通过 `PATH` 或显式 Discovery Override 找到；
3. CLI 可以在没有交互设置的情况下输出版本；
4. 本地开发时，Claude 或 Codex ACP Adapter 位于 `node_modules/.bin`。

Agent Discovery 在 Server 启动时执行。修改可执行文件路径后需要重启 Kubecode。

## ACP Connection Failed

从相同 Project Directory 直接运行 Agent CLI，确认已经登录，然后运行可选的
Real-Agent Smoke Test。不要把 Provider Config 或 API Key 粘贴到 Issue 中。

对于 OpenCode Directory Failure，可以比较：

```bash
pwd
git rev-parse --show-toplevel
opencode acp --cwd "$PWD"
```

Project 必须仍然存在；Kubecode Project Record 必须解析到相同 Canonical
Directory；Notebook User 必须有访问权限。Team Member 应继承已解析的 Member
Workspace，不能使用 Null 或过期 Path。

## Kubeflow 页面或 WebSocket 失败

- 确认 `NB_PREFIX` 与 Notebook 分配的 Route 完全一致。
- 检查该 Prefix 下的 `/healthz` 和 `/readyz`。
- 确认 Proxy 转发 WebSocket Upgrade。
- 不要让 Browser 直接调用 Pod Loopback Address。
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

## Git Diff 返回错误

确认选择的 Path 相对于 Project Root，并且仍存在于 Repository 中。重新打开
Diff 前先刷新 Git Status。对于 Submodule、Rename、Binary File 或特殊
Worktree State，报告 Kubecode Bug 前先用本地 Git 检查相同路径。

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
- Browser 与 Kubeflow Version；
- Deployment Mode 和 `NB_PREFIX`；
- Agent Name 与 Version；
- 简洁的 Reproduction Step；
- 已移除 Credential、Path、Prompt、Filename 和 File Content 的相关日志。

安全漏洞必须遵循 [SECURITY.md](../../../SECURITY.md)。
