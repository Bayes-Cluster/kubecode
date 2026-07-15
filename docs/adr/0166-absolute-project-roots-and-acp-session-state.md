# ADR-0166: Absolute Project Roots and ACP Session State

## Status

Accepted

## Context

Kubecode previously treated every Project as a relative directory below
`PERSISTENT_DIR` and retained only prompt-run text/tool events from ACP. That
prevented users from registering an existing server directory and discarded
Agent-native session titles, history, commands, plans, modes, configuration,
usage, and lifecycle capabilities.

## Decision

Projects are stored as canonical absolute server paths. `PERSISTENT_DIR` remains
the Kubecode state home and its `.state` subtree cannot be registered or browsed.
Every file, Git, Terminal, and Agent operation still resolves through the
registered Project root and applies project-relative containment checks.

Agent state is ACP-first. Kubecode stores run events for turn status and a
separate monotonically ordered Session event stream for native history and
between-turn state. The Session actor keeps one ACP connection alive for thirty
idle minutes and serializes prompt, mode, and config commands. Native
list/load/resume/fork/delete operations are exposed only when the Agent advertises the
corresponding capability. Structured elicitation requests are persisted and
rendered as shadcn form controls while the ACP request remains pending. Unknown
ACP extension metadata is retained in JSON
payloads instead of being interpreted through an Agent-specific private CLI
protocol.

Session titles store independent manual and Agent values. Manual titles win;
clearing one returns control to Agent title updates.

## Consequences

- A browser can register any directory visible to the server process, including
  PVC paths outside `PERSISTENT_DIR`.
- The server directory picker must be treated as a privileged server-side view;
  deployment filesystem permissions remain the outer authorization boundary.
- Native Agent history and state survive browser refreshes and can be rendered
  without inventing Codex-, Claude-, or OpenCode-specific wire protocols.
- ACP capability gaps result in hidden controls rather than failing UI actions.
- Existing relative Project rows are migrated to canonical paths below their
  former persistent root when the workspace database opens.
