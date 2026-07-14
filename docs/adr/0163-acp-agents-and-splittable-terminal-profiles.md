# ADR 0163: ACP agents and splittable terminal profiles

## Status

Accepted

## Context

Kubecode originally invoked Claude Code, Codex, and OpenCode with three provider-specific
one-shot JSON formats. That made the browser experience responsible for semantics that are
already standardized by the Agent Client Protocol (ACP), including streamed content, tool
calls, permission requests, cancellation, and resumable sessions.

The terminal is a separate byte-stream interface. Users need both a normal project shell and
the native interactive TUI of any discovered coding agent, with editor-style split panes.

## Decision

- The AI panel is an ACP client. The server uses the official Rust ACP SDK over JSON-RPC stdio.
- Claude and Codex run through pinned official ACP adapters. OpenCode runs its native
  `opencode acp` command.
- The web package installs the pinned Claude and Codex adapters for local development;
  the container installs the same versions globally. Each adapter receives the discovered
  CLI path so existing CLI-managed authentication and configuration remain authoritative.
- Agent authentication, model choice, and provider configuration remain owned by each agent.
- ACP session IDs are stored with conversations. A new adapter process attempts
  `session/load` before creating a replacement session.
- ACP updates are translated once into Kubecode's durable event vocabulary; the browser keeps
  Tolaria's existing AI panel interaction and rendering components.
- Safe mode rejects ACP permission requests by default. Power mode selects an allow option.
- Terminals are PTY sessions with one of four profiles: Regular, Claude Code, Codex, or
  OpenCode. Agent profiles use the same discovered executable paths as the AI catalog.
- Terminal split state is a browser-side recursive tree. Every leaf owns an independent,
  reconnectable server PTY; horizontal and vertical split ratios are freely draggable between
  small usability bounds.

## Consequences

The server no longer maintains three private output parsers. ACP adapters become part of the
deployment image and must be pinned alongside the three CLI versions. AI protocol traffic and
TUI terminal traffic remain intentionally separate: ACP is structured and durable, while a TUI
is an opaque terminal byte stream.
