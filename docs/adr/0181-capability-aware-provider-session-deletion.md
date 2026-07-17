# ADR 0181: Capability-aware provider Session deletion

## Status

Accepted. Supersedes ADR 0180 only where it requires every provider-backed
Session deletion to use ACP `session/delete`.

## Context

OpenCode 1.17.20 advertises ACP `sessionCapabilities.close` but not
`sessionCapabilities.delete`. ACP `session/close` only cancels work and releases
resources; it does not remove a Session from provider history. OpenCode does,
however, expose the non-interactive native command
`opencode session delete <sessionID>`.

Requiring ACP delete for every Agent therefore made the user-facing `Delete`
action return HTTP 500 for OpenCode while substituting `session/close` would
have falsely reported that history was deleted.

## Decision

Kubecode continues to prefer advertised ACP `session/delete`. When an OpenCode
ACP adapter does not advertise that capability, `AgentRuntime` invokes the
discovered OpenCode executable with the separate arguments `session`, `delete`,
and the stored provider Session ID. The command runs in the Session execution
directory, never through a shell, has a bounded timeout, and must exit
successfully before Kubecode removes local metadata.

This fallback is restricted to OpenCode because it is a documented native
command of that supported Agent. ACP `session/close` is never treated as
deletion. Codex and Claude Code still fail visibly when their adapters cannot
provide a true provider-history deletion operation.

## Consequences

- OpenCode Teams can be disbanded without retaining native child Sessions even
  though the ACP adapter only advertises close.
- Command arguments are not shell-interpolated and provider deletion failure
  preserves the Kubecode record for retry.
- Provider-specific lifecycle fallbacks remain explicit exceptions rather than
  weakening the cross-Agent ACP contract.
