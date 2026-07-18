# Team Session

[文档首页](../README.md) · [English](../../guides/team-sessions.md)

Team Session 通过 Kubecode 的认证 Team MCP 控制面协调多个独立 ACP Session。

## Role

- **Leader** — 负责 Task Planning、Teammate Selection、Review、Synthesis 和
  Final Response。Leader 可以修改结果，但不被分配普通 Implementation Task。
- **Teammate** — 在独立 Agent Session 中工作，并报告 Plan、Progress、
  Result、Blocker 和 Permission Request。
- **Discriminator** — 在 Team Policy 要求时执行独立只读验证，不承担实现工作。

Leader 在 Team 生命周期内保持固定。Remove Teammate 不能影响 Leader Identity。

## 创建 Team

选择 **New session**，然后选择 **Team**：

1. 选择 Leader Agent 和原生配置；
2. 输入 Team Goal 与 Acceptance Criteria；
3. 选择允许使用的 Teammate Agent；
4. 选择 Shared 或 Isolated Member Workspace；
5. 选择 Standard 或 YOLO。

Kubecode 在工作开始前持久化 Team 和 Leader，Server 重启后可以恢复。

## Standard 与 YOLO

**Standard** 保留 Provider 原生 Permission，并在需要时升级决策。

**YOLO** 是 Kubecode Team Execution Policy，不是 Provider Mode 名称。只有
Agent 公布了安全、精确的映射时，Kubecode 才会把它转换为 Provider 原生最大
权限。YOLO 还要求完成前进行独立验证。如果缺少必要 Permission Mapping 或
Verifier，Kubecode 会回退到 Standard，并显示 Effective Mode。

## Task 与协作

Leader 通过 Team MCP Tool：

- 查询可用 Agent 及其配置；
- 创建和移除 Teammate；
- 创建、分配、取消和 Review Task；
- 发送消息并检查持久化 Mailbox；
- 观察 Member Status 和 Blocker；
- Complete 或 Pause Team。

Task 可以依赖其他 Task，只有已解除阻塞的工作才应该分配。Teammate Plan、
Message 和 Result 保存在该 Teammate 自己的 Session 中，用户可以持续检查完整
协作历史。

当 Teammate 报告 Result、Blocker、Permission Decision 或 Terminal Failure
时，Kubecode 会唤醒 Idle Leader。Timeout 和 Provider Limit 会转化为 Member
Status，避免 Leader 无限等待。

## Permission

Teammate Permission Request 先交给 Leader。Leader 只能批准 Agent 提供的
Option。如果 Leader 判断需要人类决策，Kubecode 会把相同请求和精确 Option
升级给用户。

Discriminator 始终保持只读，包括 YOLO Mode。

## Workspace

Shared Member 在相同 Project Workspace 中工作。Isolated Member 使用 Server
管理的 Git Worktree。Kubecode 记录 Base Revision，并在接受 Isolated File
Change 到 Leader Workspace 前运行 Review Workflow。

协同分析或有意识地共享编辑时使用 Shared；多个 Teammate 可能独立修改重叠
代码时使用 Isolated Workspace。

## Lifecycle

Team 可以处于 draft、starting、active、paused、verifying、needs attention、
completed、archived、disbanding 或 removed。Supervisor 持久化 Member
Heartbeat、Task State、Mailbox Message 和 Wake Event。

Remove Teammate 会断开 Actor、释放活动 Assignment、移除 Kubecode Membership
和本地 Session Record，同时保留 Provider 原生历史。Disband Team 遵循相同的
Local-only Delete Policy。

用户直接与 Teammate 对话默认关闭；需要检查或干预时可以在 Settings 中开启。
