# Project、文件与 Git

[文档首页](../README.md) · [English](../../guides/projects-and-files.md)

## Project 是 Server Path

Kubecode Project 是 Server 上已经存在的绝对目录。选择 **Add Project**，通过
Server File Picker 浏览并选择目录。Kubecode 会在注册前规范化路径。

注册完成后，浏览器只接收 Project ID。后续文件、Git、Terminal 和 Session
请求使用这个 ID，而不是向浏览器暴露任意 Server Path。

Remove Project 只会取消 Kubecode 注册，不会删除目录及其内容。取消注册前，
应有意识地处理仍属于该 Project 的 Session。

## 文件与编辑器

Explorer 提供：

- 懒加载 Project File Tree；
- 新建文件和文件夹；
- Rename 与 Delete；
- File Search 与 Path Reference；
- 轻量 CodeMirror 编辑器；
- 可配置 Code Font 和 Auto Save。

所有操作都相对于已注册 Project Root。Server 会验证 Symlink 和 Path
Component，越过 Project Root 的请求会被拒绝。

编辑器有意保持轻量。当需要 Language Server、Debug 或 Extension 生态时，
请使用 Terminal 或其他 IDE。

## 自动刷新

Kubecode 会监听每个已注册 Project Directory，让 Explorer 和 Git Changes 在编辑器
之外发生文件变化时保持最新。Terminal、Git、Agent 或 Server 上其他进程引起的
变化会以失效事件的形式体现，而不需要手动刷新。

监听是 best-effort 的，并且始终不作为权威数据来源。Server 会先合并 (Coalesce)
一段时间内的活动，再通知浏览器；当它无法对变化分类或通知溢出时，会退化为刷新
整个 Project。添加和移除 Project 会自动更新监听；监听失败不会隐藏 Project，
Kubecode 会重试。Files 与 Git 视图始终可按需获得权威数据，Manual Refresh 也始终
可用。普通事件包含经过验证的 Project-relative Entry，只刷新其已加载的 Parent
Directory；跨目录 Rename 会同时包含两侧，从而刷新两个 Parent 并清理受影响的
Descendant Cache。`.git` Metadata 只产生 Git Event，普通事件还会让 Git Status
变脏。Watcher Queue、Backend、Path 或 Batch 溢出会产生 Full Invalidation。事件不
包含绝对 Server Path、File Content 或 Mutation Instruction。

每次 Initial SSE Open、重连、Watcher 恢复或 Full Invalidation 都会把已加载的
Directory 标记为 Stale，并刷新 Files 与 Git，而不会重放 Path。Directory Read 失败
时旧 Row 会保留并标记为 Stale，同时显示可恢复错误；Manual Refresh 会重试。Diff
失败可以重试，Status 截断会只显示有界前缀并显示警告。

## Git Changes

对于 Git Repository，Changes Tree 支持：

- 刷新状态；
- Unstaged 与 Staged Diff；
- Stage 与 Unstage；
- Discard；
- 初始化 Repository；
- Commit。

点击变更文件可以打开 Diff。Git Path 会相对于 Project 进行验证，并且不会被
插值到 Shell Command 中。

状态最多返回前 10,000 条完整记录或 1 MiB。响应会标记列表只是前缀；请减少
Repository 中的变更并刷新以查看其余内容。单个 Staged、Unstaged 和
Untracked Diff 最多为 2 MiB。二进制、超大或不支持的 Diff 会明确显示为不可用，
而不会静默截断。

Status Invalidation 会等待 250 毫秒，每个 Project 同时最多执行一个 Status Request；
Request 运行期间的更多变化只产生一个 Follow-up。Mutation Response 会立即应用，
其 Echo Event 会合并。Files 和每个 Git Group 在可见 Row 不超过 200 时使用普通 DOM，
超过 200 时使用 Virtualized List。Virtualization 只减少挂载的 Row，保留稳定 Path
Identity、Tree Keyboard 和 Screen Reader 语义，以及 Selection 和 Expansion State。

Discard 是不可恢复的破坏性操作。操作前请检查 Diff 并确认路径属于正确的
Project。

## 可选 Workspace Mode

Session 可以直接在 Project Directory 中运行，也可以使用 Server 管理的 Git
Worktree。Workspace Mode 可以隔离不同 Session 的文件变更，同时共享相同的
Repository History。

当 Session 应直接操作原始 Project 时可以关闭 Workspace Mode。Kubecode 会
通过 Checkpoint 流程迁移受管理的 Session Workspace；继续前需要处理报告的
冲突。

## Path Reference

使用 Composer 的 **+** 菜单，或者输入 `@path` 引用 Project Context。
Kubecode 会先验证引用，再交给 Agent；如何读取和使用文件仍由 Agent 决定。

## #56 Verification Map

Parent Issue 的 Acceptance Criteria 由以下测试或 Manual Check 负责：

| #56 Criterion | Verification |
| --- | --- |
| Kubecode Mutation 刷新受影响 Parent | `server/tests/api.rs` Entry Mutation 测试；`ContextWorkbench.test.tsx` Scoped Refresh 测试 |
| Agent、Terminal、Git 与外部修改自动出现 | `server/src/project_watcher.rs` External Write 测试；Manual Agent/Terminal Check |
| 跨目录 Rename 刷新两侧 | `ProjectFileTree.test.tsx` Cross-directory Rename；`server/tests/workspace.rs` Rename |
| Burst 有界且合并 | Watcher Coalescing；`useGitStatusController.test.tsx` Burst 与 Single-flight |
| Overflow 变成 Full Invalidation | Watcher 257-path、Overflow Flag 与 Backend Error 测试 |
| SSE 重连同时恢复 Files 与 Git 且不携带 Path | `ContextWorkbench.test.tsx` Reconnect；`useWorkspaceEventStream.test.tsx` Reconnect |
| 丢弃过期 Directory、Status、Diff 响应 | `ProjectFileTree.test.tsx`、`useGitStatusController.test.tsx`、`ContextWorkbench.test.tsx` |
| Porcelain v2 保留必需记录身份 | `server/src/git.rs` Parser；`server/tests/git.rs` Status/Conflict/Submodule |
| Conflict、Staged、Changes 使用正确列 | `ContextWorkbench.test.tsx` Projection 测试 |
| 大型 Status/Diff 有界且可恢复 | `server/tests/git.rs` Bounded 测试；浏览器 Localized State 测试 |
| Untracked Diff 不在浏览器读取整文件 | `ContextWorkbench.test.tsx` `readFile` 断言；`server/tests/git.rs` |
| 大型 Files 与 Git List 保持可访问 | `ProjectFileTree.test.tsx`、`ContextWorkbench.test.tsx`、Playwright Smoke |
| Unregister 停止 Watcher 且不删除内容 | Watcher Unregister；`server/tests/workspace.rs` |
| Analytics 不包含敏感数据 | `AgentSessionWorkspace.test.tsx`；Manual Event Schema Audit |
| Required Gates 通过 | `AGENTS.md` 命令；本地 Docs 与 Localization Check |

Manual Check 使用临时 Project，只删除 Kubecode Registration，不删除 Project
Directory 或 Provider-native History。
