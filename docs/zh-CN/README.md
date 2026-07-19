# Kubecode 文档

[English](../README.md) · [简体中文](README.md)

Kubecode 是以 Standalone Linux 应用形式发布的可自托管浏览器 AI 编程
工作区。运行 Kubecode 时请从用户指南开始；Architecture 与 ADR 主要面向
贡献者。

## 用户指南

1. [安装](guides/installation.md)
2. [Project、文件与 Git](guides/projects-and-files.md)
3. [Agent Session](guides/agent-sessions.md)
4. [Team Session](guides/team-sessions.md)
5. [Terminal 与 TUI Session](guides/terminal.md)
6. [配置](guides/configuration.md)
7. [故障排查](guides/troubleshooting.md)

## 开发者文档

- [Architecture](../ARCHITECTURE.md)
- [核心抽象](../ABSTRACTIONS.md)
- [架构决策记录](../adr/README.md)
- [品牌资源](../assets/brand/README.md)
- [贡献指南](../../CONTRIBUTING.md)
- [安全策略](../../SECURITY.md)

## 产品边界

- Project 是 Server 上的绝对路径。
- Kubecode 目前支持 Claude Code、Codex 和 OpenCode。
- Provider 凭据和模型配置仍由 Agent CLI 管理。
- Remove Project 永远不会删除目录。
- Delete Session 永远不会删除 Provider 原生历史。
- Browser Route 支持可选的通用 Base Path。
- 官方 Release 是 Standalone Linux Archive，不是 Container。

本目录是文档的唯一真源。Kubecode 不维护独立 GitHub Wiki 或文档站副本。
