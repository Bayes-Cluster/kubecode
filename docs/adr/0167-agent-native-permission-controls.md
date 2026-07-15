# ADR 0167: Agent-native permission controls

## Status

Accepted

## Context

ADR 0164 introduced a Kubecode-owned Safe/Power selector. Safe waited for a
browser decision when an ACP Agent requested permission, while Power selected
an allow option automatically. Agents now expose their own modes and
configuration through ACP, so the extra Kubecode policy duplicates native
controls and can override the Agent's intended permission flow.

## Decision

- The prompt API accepts only the user message; it has no Kubecode permission
  mode.
- The composer renders only modes and configuration advertised by the active
  ACP Agent.
- When an Agent sends an ACP permission request, Kubecode preserves the
  Agent-provided choices and waits for the user to select one. It never
  auto-selects an allow or reject choice.
- The legacy `permission_mode` run column remains a storage compatibility field
  until a later data migration and has no runtime policy effect.

This supersedes only the Safe/Power permission-policy decision in ADR 0164.

## Consequences

Permission behavior now follows Claude Code, Codex, or OpenCode rather than a
second Kubecode abstraction. Agent-native permission modes remain changeable
through ACP, and explicit permission requests remain reconnectable in the web
UI. Existing run rows remain readable without a database migration.
