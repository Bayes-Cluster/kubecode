# ADR 0177: Leader-governed Team Sessions over ACP and MCP

## Status

Accepted. Supersedes ADR 0176's parent/child `team_member` relationship as the product-level Team model.

## Context

Provider-native subagents are useful inside one Agent, but they cannot coordinate durable work across Codex, Claude Code, and OpenCode. Treating a Team member as a child conversation also leaves no durable task graph, mailbox, authority boundary, or review state.

## Decision

Kubecode persists Team, TeamMember, TeamTask, and TeamMessage records independently from provider-native Agent children. A Team starts with exactly one fixed Leader. Only the Leader may create teammates, define tasks, review results, and issue the final response. Teammates have independent ACP conversations and may claim unblocked work or message any Team member.

Every newly created Team member ACP session receives an in-process `kubecode-team` MCP server. The tools expose the shared Team protocol while each provider remains responsible for its native model, permission, plan, and subagent behavior. Provider-native children remain nested inside their owning Team member and never become Team members implicitly.

Shared members use the Team execution root. Isolated members receive a separate Git worktree and record the base tree for later Leader review. Result submissions enter the Leader's durable mailbox; an idle Leader is automatically continued, while an active Leader consumes the mailbox after its current turn.

The browser lists Team snapshots beside ordinary Sessions. A compact Team overview switches directly among member chats and shows live task progress. Existing Solo Sessions can be promoted without replacing their conversation ID or history.

## Consequences

- ACP remains the Agent lifecycle protocol and MCP is the Team control plane; A2A is not required.
- Leader authority is enforced in SQLite transactions, not only through prompts or UI.
- Team state survives browser refreshes and ACP process restarts independently of provider history.
- MCP attachment is currently exercised on new ACP sessions. Load/resume attachment needs an upstream SDK session-builder equivalent before provider-native resume can retain the in-process tool bridge without creating a replacement session.
- Legacy `relationship=team_member` rows remain readable during migration but new product Teams do not create them.
