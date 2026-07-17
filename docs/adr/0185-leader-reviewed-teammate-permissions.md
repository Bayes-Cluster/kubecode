# ADR 0185: Leader-reviewed teammate permissions

## Status

Accepted. Extends ADR 0177 and ADR 0183.

## Context

Directly asking the user for every Teammate ACP permission defeats Leader
authority and interrupts autonomous Team coordination. Automatically approving
requests would bypass the Agent's native permission semantics.

## Decision

Kubecode persists each Teammate permission request with the exact ACP options,
adds it to Team context, and wakes the fixed Leader. The Leader must call
`team_review_permission` to select an advertised option or explicitly escalate
the request to the user. There is no timer-based escalation. A waiting
Teammate does not prevent the Leader from receiving the coordination turn.
Leader-owned ACP permissions continue to go directly to the user.

## Consequences

- Approval authority is enforced by Team membership and exact option IDs.
- Permission decisions remain visible in Team activity and survive browser
  refreshes.
- Server or Agent interruption cancels the live request rather than pretending
  that an ACP callback can be resumed.
- Human permission controls appear only after Leader escalation.
