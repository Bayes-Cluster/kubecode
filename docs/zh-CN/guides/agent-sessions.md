# Agent Session

[文档首页](../README.md) · [English](../../guides/agent-sessions.md)

## 支持的 Agent

Kubecode 支持 Claude Code、Codex 和 OpenCode。Server 启动时进行 Agent
Discovery，并为不可用 Agent 报告可执行文件、版本和诊断信息。

Claude Code 与 Codex 使用项目安装的 ACP Adapter；OpenCode 通过
`opencode acp` 提供 ACP。认证和 Provider 配置不由 Kubecode 管理。

## 创建或 Import Session

选择 Project 并点击 **New session**：

1. 选择可用 Agent；
2. 可选地输入 Title；
3. 选择直接 Project 或 Workspace Mode；
4. 选择 Agent 原生 Mode、Model、Effort 或其他已公布配置；
5. 启动 Session。

Title 为空时，Kubecode 会从第一段有效对话活动中生成短标题。Title 仍可编辑。

Import 会列出该 Agent 暴露的 Provider 原生 Session。Import 只会在 Kubecode
中注册 Session 并恢复可用历史，不会复制或删除 Provider History。

## ACP Capability

Kubecode 渲染当前 Agent 公布的 Capability，而不是维护一个统一 Provider
抽象。根据 Agent 的能力，UI 可能提供：

- 原生 Slash Command；
- Session Resume 与 Fork；
- Model、Mode、Effort 或 Fast Mode；
- Structured Plan、Todo、Tool Call 和 Checkpoint；
- Agent 提供的 Permission Choice；
- Structured Question；
- Markdown 与 LaTeX 输出。

某个控件不存在，通常表示当前 Adapter 或 Session 没有公布该能力。

## Composer

Agent 运行时 Composer 仍然可以输入。是否可以立即提交由当前 Session 状态
控制；如果必须先停止 Agent，请 Interrupt 当前 Turn 后再发送替代指令。

**+** 菜单用于引用 Project File 或 Agent 支持的 Skill。Agent Configuration
统一收纳到一个 Capability Menu，避免 Provider 专属选项挤满输入行。

## Permission

Kubecode 不再添加 Safe/Power Mode。Agent 请求权限时，Kubecode 只显示该
Agent 提供的精确选项。用户可以 Allow、在 Agent 提供时按 Scope Allow，或者
Reject。

Provider 原生配置是最终权威。Kubecode 不会根据 Display Label 猜测 Agent
没有公布的选项。

## Edit、Branch 与 Undo

Provider Session 通常是 Append-only。修改已发送消息时，如果 Agent 无法安全
回退，Kubecode 会用新的 Provider Continuation 构建修订后的 Timeline。
Kubecode 保持 Logical Session 稳定，并隐藏用于重建上下文的合成消息。

Undo 使用捕获的 Turn Checkpoint。如果 Provider 没有产生安全的 After-turn
Checkpoint，或者 Workspace 在捕获后被外部修改，Undo 可能失败。重试前请先
阅读应用内提示。

## Delete 语义

**Delete** 会从 Kubecode 移除 Session、Run、Revision 和标准化 Event，并断开
活动 Actor；它不会要求 Provider 删除原生历史。当 Agent 再次暴露该 Session
时，用户仍可以重新 Import。
