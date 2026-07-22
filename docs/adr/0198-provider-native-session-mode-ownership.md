---
type: ADR
id: "0198"
title: "Provider-native Session mode ownership"
status: active
date: 2026-07-21
---

## Context

Claude Code, Codex, and OpenCode advertise different Session modes with
provider-owned identifiers, labels, descriptions, and semantics. Treating them
as one Kubecode Plan/Build enum would discard those semantics and incorrectly
mix OpenCode's Build/Plan profile with the Team permission policy.

Mode also has more constrained ownership than model, effort, fast mode, and
other dynamic Agent configuration. A user change during an active turn is
ambiguous, Team Teammates are configured by their Leader, Discriminators are
read-only, and Codex or Claude Code permission modes may be fixed by Team YOLO.

## Decision

Kubecode presents the exact provider-native Session mode in a dedicated
Composer control. The control preserves the Agent's mode IDs, names, and
descriptions. Dynamic model, effort, fast mode, and other provider settings
remain in Agent settings.

The normalized Session option projection prefers ACP `current_mode`. When an
Agent exposes mode only as a select configuration whose category or ID is
`mode`, that configuration becomes the mode control. An equivalent duplicate
configuration is removed by exact option ID/name signature; distinct provider
configuration remains visible.

Mode is retained through the existing ordered Session events. Kubecode adds no
mode column and stores no application-wide mode preference. A new Session uses
the provider default.

`GET /sessions/:id/state` includes `mode_access`, with `can_change` and a stable
lock reason. User mode changes are rejected with `409 session_mode_locked`
during an active turn, in read-only Sessions, for Team Teammates and
Discriminators, and when Team YOLO owns a Codex or Claude Code permission mode.
The same enforcement applies to mode-like configuration updates. An idle
Standard Team Leader may change mode. OpenCode Build/Plan remains an editable
Leader profile under YOLO because OpenCode maximum permission is supplied by
the separate process environment policy.

Provider updates and Leader-owned internal Team configuration continue through
their existing runtime paths; `mode_access` governs user-facing Session API
mutations.

## Consequences

- The UI does not claim that differently named provider modes are equivalent.
- Provider additions can advertise modes without adding a Kubecode enum or
  migration.
- Mode changes apply to the next turn and cannot alter a running user turn.
- Team ownership is visible in the control and enforced by the server rather
  than relying on a disabled browser button.
- Removing a Project or Session still does not remove provider-native history.
