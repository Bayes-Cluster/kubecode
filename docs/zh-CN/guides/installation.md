# 安装与部署

[文档首页](../README.md) · [English](../../guides/installation.md)

## 本地开发

环境要求：

- Node.js 22 或更高版本
- pnpm 10
- Stable Rust
- Git
- 可选：已登录的 Claude Code、Codex 或 OpenCode CLI

安装依赖并启动 Rust API：

```bash
pnpm install
pnpm dev:server
```

在第二个终端中启动 Vite：

```bash
pnpm dev
```

打开 <http://127.0.0.1:5202>。Vite 会把 API 和 Terminal WebSocket 请求代理到
8888 端口。开发状态写入 `.local/`。

## 以生产模式在本地运行

```bash
pnpm build
PERSISTENT_DIR="$PWD/.local/workspace" \
KUBECODE_STATE_DIR="$PWD/.local/state" \
KUBECODE_STATIC_DIR="$PWD/dist" \
PORT=8888 \
cargo run --manifest-path server/Cargo.toml
```

打开 <http://127.0.0.1:8888>。

## Container 镜像

```bash
docker build -f deploy/Dockerfile -t kubecode:local .
```

生产镜像包含：

- 构建后的 React 应用和 `kubecode-server`；
- Claude Code、Codex 和 OpenCode；
- Claude 与 Codex ACP Adapter；
- Git、tmux、ripgrep、SSH 工具和 s6 初始化。

固定的 Agent 与 Adapter 版本位于 `deploy/Dockerfile` 的 Build Argument 中。
发布镜像前应有意识地更新这些版本，并运行真实 Agent Smoke Test。

## Kubeflow Notebook

`deploy/kubeflow-notebook.yaml` 提供参考 PVC 和 Notebook 资源。应用前需要：

1. 将镜像发布到集群可以访问的位置；
2. 替换 `ghcr.io/example/kubecode:latest`；
3. 将 `NB_PREFIX` 设置为 Kubeflow 分配的路径；
4. 将 `PERSISTENT_DIR` 设置为挂载的用户工作区；
5. 根据集群策略调整 PVC、Namespace、Security Context 和资源请求。

镜像暴露 8888 端口。`/healthz` 和 `/readyz` 位于配置后的 Base Path 下。

## 持久化数据

Container 默认把工作区文件存放在 `PERSISTENT_DIR`，把 Kubecode 状态存放在
`$PERSISTENT_DIR/.state/kubecode`。初始化脚本也会把受支持 Agent CLI 的配置
持久化到 `$PERSISTENT_DIR/.state`。

请根据集群策略备份挂载卷。Kubecode 状态包含 Session Metadata 和标准化
Agent Event；Provider Credential 仍位于 CLI 自己管理的目录。

## Agent 发现

Kubecode 启动时检查继承的 `PATH`、常见安装目录和 Login Shell Path。本地
开发可以通过以下变量覆盖发现结果：

```text
KUBECODE_CLAUDE_PATH
KUBECODE_CODEX_PATH
KUBECODE_OPENCODE_PATH
KUBECODE_CLAUDE_ACP_PATH
KUBECODE_CODEX_ACP_PATH
```

请使用各 CLI 的官方文档完成安装和登录。不要把 Provider API Key 写入
Kubecode 配置。

可以在不发送 Prompt 的情况下验证真实 Adapter：

```bash
KUBECODE_REAL_AGENT=opencode pnpm test:agents:real
```

也可以使用 `claude_code`、`codex` 或 `all` 选择其他 Agent。
