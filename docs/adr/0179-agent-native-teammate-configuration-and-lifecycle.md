# ADR 0179: Agent-native teammate configuration and lifecycle

## Status

Accepted. Extends ADRs 0177 and 0178.

## Context

A Team Leader could create a teammate but could not choose that Agent's ACP mode or dynamic configuration, including its model. The Team MCP server also had no stop/remove operation. Deleting the teammate's underlying Kubecode Session left a stale member record, which made Team snapshot construction fail and caused the Leader identity to disappear from the browser.

## Decision

`team_spawn_teammate` accepts an optional ACP mode ID and a map of agent-native session configuration IDs to boolean or value IDs. Kubecode starts the independent ACP Session first, applies those settings through ACP, and rolls the complete member creation back if initialization or configuration fails. Kubecode does not translate provider model names or define a cross-Agent model catalog.

`team_remove_teammate` is a Leader-only lifecycle operation. It disconnects the teammate ACP actor, removes Team messages involving that member, releases active task assignments back to pending, removes the member, and deletes only the local Kubecode conversation record. Project files and provider-native history are not deleted.

The ordinary Session deletion endpoint follows the same Team-aware lifecycle. Deleting a teammate removes only that teammate; deleting the Leader removes the Team coordination record. ACP shutdown cancels an active prompt before closing its connection, so a working teammate does not survive invisibly after removal.

## Consequences

- A Leader can request settings such as `session_options: {"model":"zhipu/glm-5.2"}` when the selected Agent advertises and accepts that exact option value.
- Unsupported configuration fails visibly and does not leave a zombie member.
- Removed teammates disappear from Team snapshots and no longer own pending work.
- Manually deleting a teammate Session cannot invalidate the remaining Team or hide its Leader.
- Agent-specific option IDs and values remain owned and validated by the Agent through ACP.
