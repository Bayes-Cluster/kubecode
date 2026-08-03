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
可用。每次重连都会为每个打开的 Project 请求一次全新的完整视图。

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
