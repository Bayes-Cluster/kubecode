---
type: ADR
id: "0160"
title: "Remove the CodeScene quality gate"
status: active
date: 2026-07-14
supersedes: "0064"
---

## Context

The repository inherited a CodeScene MCP, CLI, API, threshold, CI, and hook
integration from Tolaria. Kubecode does not have a CodeScene account or access
token, so the integration cannot produce a local baseline and adds a release
dependency that the project cannot operate.

## Decision

**Remove CodeScene from the active development and release workflow.** Keep
lint, type checking, tests, coverage, Playwright, and Codacy as the enforced
quality and security gates.

## Consequences

- Developers no longer need CodeScene credentials, MCP tools, or CLI binaries.
- CI and Git hooks do not fetch remote code-health scores or maintain threshold
  files.
- Historical ADRs and release notes remain unchanged as records of the Tolaria
  baseline; this ADR supersedes their active policy.
- Maintainability is evaluated through review, small typed changes, tests,
  coverage, linting, and static security analysis.
