# ADR 0183: Durable Team runtime and member Chat isolation

## Status

Accepted. Extends ADR 0177 with scheduling, delivery, and browser presentation
rules.

## Context

A persistent Team needs more than a shared MCP tool list. A Leader must be able
to discover available Agents, propose a lineup, configure each teammate through
its native ACP options, delegate work, and reliably wake an idle recipient.
Without durable delivery state, a message can be lost during a restart or replay
forever. Rendering every member's output in the Leader Chat also obscures who
performed the work and breaks each provider Session's history.

## Decision

Team coordination remains an ACP + MCP design. SQLite is the source of truth for
the roster, tasks, proposals, structured activity, runtime settings, and message
delivery. Each message records pending, delivered, acknowledged, or failed
state. Delivery wakes the recipient's existing ACP Session with an internal run;
failed delivery is retried at most three times. Reading Team context acknowledges
the mailbox. A configurable concurrency limit bounds simultaneous Team runs.

MCP tools are role-specific. The Leader can discover installed Agents, propose
and configure a lineup with Agent-native ACP options, delegate tasks, and review
results. Teammates receive only the context, communication, task execution, and
status tools appropriate to their role. The Leader retains final authority.

Every member owns an independent durable Agent Chat. Internal wake prompts are
not rendered as user messages and do not retitle the Chat, but the Agent's
reasoning, tool calls, permission requests, and response remain visible in that
member's timeline. The browser provides separate Chat and Team views: Chat
navigates directly among member Sessions, while Team shows runtime metrics,
attention, lineup approval, members, tasks, dependencies, and activity. Team
events refresh the snapshot over the existing workspace event stream.

## Consequences

- Teammate work remains attributable, inspectable, and resumable in its own
  provider Session and Kubecode timeline.
- Server or browser restarts do not discard Team configuration, proposals,
  activity, mailboxes, or member identity.
- Team coordination cannot exceed the configured parallel Agent limit.
- Message delivery is at-least-once before acknowledgement, with a finite retry
  limit and visible failure state.
- The Team view is a control surface, not a merged transcript.
