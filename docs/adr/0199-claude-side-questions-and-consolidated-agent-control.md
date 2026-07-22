---
type: ADR
id: "0199"
title: "Claude side questions and consolidated Agent control"
status: active
date: 2026-07-22
supersedes: "0198 (Composer presentation only)"
---

## Context

Provider-native mode and configuration are related Session controls, but two
adjacent Composer buttons consume too much space and obscure the add-context
button on narrow layouts. Provider-native slash commands also differ by Agent.
Claude Code exposes an SDK `side_question` control request while ACP 1.x has no
standard side-question method. Treating `/btw` as an ordinary prompt would
interrupt the active turn and misrepresent its semantics.

Long-running Agents may emit multiple ACP messages during one turn. Flattening
all `agent_message_chunk` content into one response discards the ACP
`messageId` boundary and produces an unreadable transcript.

## Decision

Kubecode presents mode and dynamic Agent configuration in one compact Composer
control. Its trigger contains the Agent icon and current mode; its menu contains
the provider-native mode, model, effort, boolean settings, and other advertised
configuration. Server ownership and lock rules from ADR 0198 are unchanged.

The bundled Claude ACP adapter advertises
`agentCapabilities._meta.claudeCode.sideQuestion`. While a Claude turn is
active, Kubecode adds `/btw` to that Session's available commands and sends its
question through a private `_claude/side_question` ACP extension. The adapter
dispatches the Claude Agent SDK's native `askSideQuestion()` request. Kubecode
does not add `/btw` for unsupported adapters or other Agents.

Side-question start, completion, and failure are durable Session events and
workspace events. They appear in a collapsible panel above the Composer rather
than in the main turn transcript. Only one side question may be pending per
Session.

Normalized text events retain ACP `messageId` and `_meta`. The browser groups
consecutive chunks by `messageId` and renders distinct Agent messages as
separate response blocks. Legacy events without an ID retain their existing
flat rendering.

## Consequences

- The add-context button, Agent control, input, send action, and stop action fit
  in one bounded Composer row.
- Claude `/btw` preserves the running turn and survives browser refreshes.
- Codex and OpenCode receive no invented slash commands or capabilities.
- The private extension remains isolated in the bundled adapter and can be
  removed if ACP standardizes side questions.
- Provider message boundaries improve long-output readability without changing
  durable Session or run ownership.
