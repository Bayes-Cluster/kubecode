# Kubecode documentation

[English](README.md) · [简体中文](zh-CN/README.md)

Kubecode is a browser-based AI coding workspace designed for a single-user
Kubeflow Notebook. Start with the user guide if you are running or deploying
Kubecode. Architecture and ADRs are intended for contributors.

## User guide

1. [Installation and deployment](guides/installation.md)
2. [Projects, files, and Git](guides/projects-and-files.md)
3. [Agent Sessions](guides/agent-sessions.md)
4. [Team Sessions](guides/team-sessions.md)
5. [Terminal and TUI Sessions](guides/terminal.md)
6. [Configuration](guides/configuration.md)
7. [Troubleshooting](guides/troubleshooting.md)

## Developer documentation

- [Architecture](ARCHITECTURE.md)
- [Core abstractions](ABSTRACTIONS.md)
- [Architecture Decision Records](adr/README.md)
- [Brand assets](assets/brand/README.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)

## Product boundaries

- A Project is an absolute server path.
- Claude Code, Codex, and OpenCode are the only supported Agents.
- Provider credentials and model configuration remain with the Agent CLI.
- Removing a Project never deletes its directory.
- Removing a Session never deletes provider-native history.
- Browser routes must remain compatible with Kubeflow `NB_PREFIX`.

This directory is the canonical documentation source. Kubecode does not
maintain a separate GitHub Wiki or documentation-site copy.
