---
type: ADR
id: "0172"
title: "Event-driven Agent workspace attention"
status: active
date: 2026-07-16
---

## Context

Long-running Agent Sessions continue when their browser tab or Project is not
active. A Project-local Session list cannot reliably show permission requests,
completed work, or failures elsewhere in the workspace. Replaying the complete
global event history on every browser load would also emit stale notifications.

## Decision

**Use durable workspace events as the source of live attention and expose a
separate bootstrap cursor plus global Session summaries.** The browser reads the
current cursor before opening SSE, then processes only newer events for system
notifications and global attention UI. Session summaries include latest run
status, activity time, archive state, and provider-native parent relationships.

Notification, Session-list, and layout preferences remain versioned
browser-local records. Browser/system notification permission is requested only
after an explicit user action. Notification sounds use the operating system's
notification behavior; Kubecode does not ship or autoplay audio assets.

## Consequences

- Permission and elicitation requests remain visible across Projects and can
  navigate directly to their Session.
- Refresh does not replay old completion or error notifications.
- Session navigation can group by activity and status without loading every run.
- Forks and read-only subagent transcripts can retain their parent relationship.
- Browser-local preferences do not roam between devices or users.
