# ADR 0188: Supervised Team lifecycle and local-first cleanup

## Status

Accepted. Supersedes ADR 0180 and ADR 0182 where they require provider-first
teammate removal or stop Team disbanding on a provider deletion failure. The
Solo Session deletion decision in ADR 0180 and ADR 0181 remains unchanged.

## Context

A Team spans SQLite coordination state, several independent ACP processes, and
provider-native Session history. Those systems cannot share a transaction.
Provider startup can fail after local records are created, an ACP process can
start in the server directory instead of the Project execution directory, and
a provider can be unavailable while a member is being removed. Treating any
one provider call as the Team lifecycle transaction left stale members,
unrecoverable `starting` Teams, and mailbox messages that were marked delivered
before the recipient acknowledged them.

Leader coordination also needs a durable way to stop for a real user decision.
Transient UI state cannot be the authority because Kubecode is expected to
survive browser disconnects and server restarts.

## Decision

Team and member lifecycles are explicit. Teams may be `draft`, `starting`,
`active`, `verifying`, `needs_attention`, `completed`, `archived`, or
`disbanding`. Members may additionally be `starting`, `configuring`, and
`removing` around their ordinary execution states. A server-owned supervisor
runs once at startup and every 30 seconds. It reconciles every non-terminal
Team, retries expired mailbox delivery leases, resumes queued work, and
processes due cleanup operations without depending on a Team API read or an
open browser.

Every ACP stdio process is launched with its operating-system current directory
set to the Session execution path. The ACP request `cwd` remains present, but it
is not the only directory boundary. The launcher passes the directory,
executable, and arguments as positional values and performs no shell
interpolation. OpenCode additionally receives `acp --cwd <execution-path>`
because its native directory service uses that command argument during ACP
startup.

Mailbox delivery uses a lease. Starting an Agent turn changes a message to
`delivered`; only `team_get_context` or an explicit inbox read acknowledges it.
An unacknowledged delivery is returned to `pending` after the lease, with at
most three delivery attempts.

Teammate removal and Team disband are local-first:

1. persist a lifecycle operation and any provider cleanup target;
2. disconnect the local actor;
3. remove Team membership and Kubecode Session records immediately;
4. attempt provider-native deletion;
5. retry provider cleanup after 5 seconds, 30 seconds, 2 minutes, 10 minutes,
   and 1 hour, then retain a durable failed operation for manual retry.

Provider failure never puts a removed member back into the roster and never
blocks removal of the Team control record. Project files and worktrees are not
deleted by this lifecycle. Cleanup operations intentionally do not reference
the Team with a cascading foreign key, so they survive disbanding.

Provisioning is also represented by a lifecycle operation. Transport or startup
failure rolls back the temporary member and conversation while preserving the
failed operation and activity. An invalid Agent-native configuration keeps the
member in `configuring`, where the Leader can reconfigure or replace it.

The Leader remains the semantic authority. Kubecode wakes it on results,
failures, permission requests, expired delivery, and a no-progress condition,
but never assigns semantic work automatically. The Leader can retry,
reconfigure, replace, cancel, or escalate. `team_request_user_input` creates a
durable request, moves the Team to `needs_attention`, pauses teammate
scheduling, and delivers the user's answer back through the Leader mailbox.
Completed or disbanding Teams expose read-only MCP coordination state.

## Consequences

- OpenCode and other directory-sensitive providers see the same execution path
  at process startup and in ACP Session requests.
- Browser refresh and Team list reads are no longer lifecycle triggers.
- Removing a member is deterministic from the user's perspective even during a
  provider outage; provider history cleanup may finish later.
- Team snapshots can explain pending user decisions, failed provisioning, and
  cleanup retries through durable operations and next actions.
- Lifecycle operations add metadata that must be retained independently of
  member and Team rows.
- Provider cleanup is eventually consistent and may require an explicit manual
  retry after the bounded schedule is exhausted.
