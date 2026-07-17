# ADR 0182: Leader-owned teammate deletion

## Status

Accepted. Supersedes ADR 0180 only where it exposes `Delete` for teammates or
allows the ordinary Session endpoint to remove a teammate.

## Context

A teammate is owned by a Team's fixed Leader, but the browser and the generic
Session deletion API allowed a user to delete that teammate directly. This
bypassed the Leader's coordination flow. Conversely, a resumed Leader could
lose the IDs returned when teammates were created and had no Team MCP operation
for rediscovering them, so it could not reliably call `team_remove_teammate`.

## Decision

Only the fixed Leader may delete a teammate, through the `kubecode-team` MCP
control plane. Team MCP exposes `team_list_members` so the Leader can recover
current member IDs before calling `team_remove_teammate`. Server instructions
name both operations explicitly.

The browser omits `Delete` from teammate Session actions. The generic Session
deletion endpoint rejects teammate deletion with HTTP 409 before disconnecting
the Agent actor. This server-side check is authoritative and protects callers
other than the browser.

Deleting a Solo Session remains a direct provider-native deletion. Deleting the
fixed Leader remains a confirmed Team disband operation. Deleting one teammate
through the Leader does not disband the Team.

## Consequences

- Team membership lifecycle has one authority and one audited control plane.
- A resumed Leader can enumerate and remove teammates without retaining old
  spawn responses in its model context.
- Users cannot bypass the Leader through REST or a hidden/stale browser action.
- Existing Teams at the teammate limit can be recovered by asking the Leader to
  list and remove obsolete members.
