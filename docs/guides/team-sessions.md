# Team Sessions

[Documentation](../README.md) · [简体中文](../zh-CN/guides/team-sessions.md)

Team Sessions coordinate several independent ACP Sessions through Kubecode's
authenticated Team MCP control plane.

## Roles

- **Leader** — owns task planning, teammate selection, review, synthesis, and
  the final response. The Leader may edit results but is not assigned ordinary
  implementation tasks.
- **Teammate** — works in an independent Agent Session and reports plans,
  progress, results, blockers, and permission requests.
- **Discriminator** — performs independent read-only verification when required
  by the Team execution policy. It is not an implementation worker.

The Leader is fixed for the lifetime of a Team. Removing a teammate must never
remove the Leader identity.

## Create a Team

Choose **New session** and select **Team**:

1. choose the Leader Agent and its native configuration;
2. enter the Team goal and acceptance criteria;
3. choose the allowed teammate Agents;
4. choose Shared or isolated member workspaces;
5. choose Standard or YOLO execution.

The Team and Leader are persisted before work begins and recover after a server
restart.

## Standard and YOLO

**Standard** keeps provider-native permissions and escalates decisions as
needed.

**YOLO** is a Kubecode Team execution policy, not a provider mode name. Kubecode
maps it to an exact provider-native maximum-permission profile only when the
Agent advertises a safe mapping. YOLO also requires independent verification
before completion. If a required mapping or verifier is unavailable, Kubecode
falls back to Standard and reports the effective mode.

## Tasks and collaboration

The Leader uses Team MCP tools to:

- discover available Agents and their configuration;
- create and remove teammates;
- create, assign, cancel, and review tasks;
- send messages and inspect the durable mailbox;
- observe member status and blockers;
- complete or pause the Team.

Tasks can depend on other tasks. Only unblocked work should be assigned.
Teammate plans, messages, and results are stored with that teammate's own
Session so users can inspect the full collaboration history.

Kubecode wakes an idle Leader when a teammate reports a result, blocker,
permission decision, or terminal failure. Timeouts and provider limits become
member status rather than leaving the Leader waiting indefinitely.

## Permissions

A teammate permission request is routed to the Leader first. The Leader can
approve only an option that the Agent supplied. When the Leader decides that
human judgment is required, Kubecode escalates the same request and exact
options to the user.

Discriminator Sessions remain read-only, including in YOLO mode.

## Workspaces

Shared members operate in the same Project workspace. Isolated members use a
server-managed Git worktree. Kubecode records a base revision and uses its
review workflow before accepting isolated file changes into the Leader
workspace.

Choose Shared for coordinated analysis or intentionally shared edits. Choose
isolated workspaces when teammates may modify overlapping code independently.

## Lifecycle

A Team can be draft, starting, active, paused, verifying, needs attention,
completed, archived, disbanding, or removed. The supervisor persists member
heartbeats, task state, mailbox messages, and wake events.

Removing a teammate disconnects its actor, releases active assignments, removes
the Kubecode membership and local Session record, and preserves provider-native
history. Disbanding a Team follows the same local-only deletion policy.

Direct user chat with a teammate is disabled by default. It can be enabled in
Settings when inspection or intervention is necessary.
