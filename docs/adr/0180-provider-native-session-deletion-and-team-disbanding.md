# ADR 0180: Provider-native Session deletion and Team disbanding

## Status

Accepted. Supersedes ADR 0179's deletion lifecycle and ADR 0166 only where they
describe Session deletion as local-only removal.

## Context

The browser presented one `Delete` action while the default Session endpoint
only removed Kubecode metadata. Provider-native history remained importable,
so the label did not describe the result. Deleting a Team Leader also deleted
the Team coordination row without stopping or deleting teammate Sessions,
leaving visible orphan conversations with no Leader.

## Decision

`Delete` means deletion of the Agent-native Session and its Kubecode record.
When a conversation has a provider Session ID, `AgentRuntime` requires the
Agent's ACP delete capability and sends `session/delete` before removing local
metadata. A conversation that has not created a provider Session yet is deleted
locally. An ACP capability or deletion failure is reported and does not silently
fall back to local-only removal.

The action label remains `Delete` for Solo Sessions, Team Leaders, and
teammates. Deleting a teammate stops and deletes only that member, releases its
active assignments, and preserves the Leader and Team. Deleting a Leader is a
Team disband operation: the browser requires confirmation and the server stops
and deletes every teammate, the Leader, and the Team coordination records.
Project files are never deleted by Session or Team deletion.

Provider operations cannot share a transaction across independent Agent
processes. Team disband therefore progresses member by member. A failed member
deletion stops the operation, reports the error, and preserves the Team with
the members that have not yet been deleted so the user can retry.

## Consequences

- A successfully deleted provider Session cannot be imported again from the
  Agent's native history.
- Agents that do not advertise ACP Session deletion cannot claim a successful
  deletion for an existing provider Session.
- Deleting the last teammate does not disband a Team; deleting its fixed Leader
  always does.
- The Leader confirmation names the Team and reports the affected teammate
  count, while all menu labels remain `Delete`.
