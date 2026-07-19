# 安装

[文档首页](../README.md) · [English](../../guides/installation.md)

## Standalone Release

环境要求：

- glibc 2.28 或更新版本的 Linux amd64/arm64；
- Git，用于 Git Status、Diff 和 Worktree；
- 至少安装并登录一个 Claude Code、Codex 或 OpenCode CLI。

无需 Root 权限安装最新版本：

```bash
curl -fsSL https://raw.githubusercontent.com/Bayes-Cluster/kubecode/main/install.sh | sh
~/.local/bin/kubecode
```

Installer 从 GitHub Releases 下载 Archive 和 Checksum，完成校验后将版本安装到
`~/.local/lib`，并链接 `~/.local/bin/kubecode`。它不会安装系统服务或修改
Shell 启动文件。

常用选项：

```bash
./install.sh --version 0.1.0
./install.sh --prefix /absolute/custom/prefix
./install.sh --version 0.1.0 --dry-run
```

卸载应用时删除对应版本目录和命令链接即可。应用状态位于独立目录，不会被自动
删除。

## 手动安装 Archive

从 GitHub Releases 下载 `kubecode-<version>-linux-amd64.tar.gz` 或
`kubecode-<version>-linux-arm64.tar.gz`，以及对应的
`kubecode-<version>-SHA256SUMS`。校验、解压后运行：

```bash
./kubecode-<version>-linux-<arch>/bin/kubecode
```

Archive 包含 React 应用、Rust Server、Node.js Runtime 和固定版本的
Claude/Codex ACP Adapter。它不包含 Provider Agent CLI、Credential、Git
或 Shell。

## Server 参数与状态

运行 `kubecode --help` 查看完整参数：

```text
--host
--port
--base-path
--workspace-root
--state-dir
```

Kubecode 默认监听 `127.0.0.1:8888`。它暂不提供内置认证，因此监听
Non-loopback Address 时必须配置带认证的 Reverse Proxy 或其他可信访问边界。

Directory Picker Root 默认为 `$HOME`。状态默认保存在
`$XDG_DATA_HOME/kubecode`；没有设置 `XDG_DATA_HOME` 时使用
`$HOME/.local/share/kubecode`。备份该目录可以保留 Project Registration、
Session、Team、标准化 Agent Event 和私有 Worktree。Provider Credential
仍保存在 CLI 自己管理的位置。

Release 是用户态 Linux 应用。Kubecode 不发布或维护官方 Container、
Kubernetes Resource 或 Kubeflow Notebook Manifest。下游环境可以封装
Standalone Archive，但需要自行负责 User、Filesystem、Routing、
Authentication 和 Persistence Policy。

## Agent 发现

Kubecode 启动时检查继承的 `PATH`、常见安装目录和 Login Shell Path。可以通过
以下变量覆盖 Discovery：

```text
KUBECODE_CLAUDE_PATH
KUBECODE_CODEX_PATH
KUBECODE_OPENCODE_PATH
KUBECODE_CLAUDE_ACP_PATH
KUBECODE_CODEX_ACP_PATH
```

Standalone Launcher 会自动配置两个 ACP Adapter Path。请使用各 CLI 的官方
文档完成安装和登录，不要把 Provider API Key 写入 Kubecode 配置。

可以在不发送 Prompt 的情况下验证真实 Adapter：

```bash
KUBECODE_REAL_AGENT=opencode pnpm test:agents:real
```

也可以使用 `claude_code`、`codex` 或 `all` 选择其他 Agent。

## 源码开发

源码开发需要 Node.js 22+、pnpm 10、Stable Rust 和 Git：

```bash
pnpm install
pnpm dev:server
```

在第二个终端中运行：

```bash
pnpm dev
```

打开 <http://127.0.0.1:5202>。Vite 会把 API 和 Terminal WebSocket 请求代理
到 8888 端口，开发状态写入 `.local/`。

以接近生产环境的方式运行源码：

```bash
pnpm build
cargo build --locked --manifest-path server/Cargo.toml
server/target/debug/kubecode-server \
  --workspace-root "$PWD/.local/workspace" \
  --state-dir "$PWD/.local/state"
```
