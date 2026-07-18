# ADR 0192: Local-only Session removal

## Status

Accepted

Supersedes ADR 0180, ADR 0181, and the provider-cleanup parts of ADR 0188.

## Context

Kubecode registers provider-native Agent Sessions so they can be resumed and
inspected in the browser. A Kubecode `Delete` action previously attempted ACP
`session/delete`, with an OpenCode CLI fallback, and Team removal scheduled
provider cleanup in the background.

That behavior made a workspace-organizing action destructive outside
Kubecode. It also contradicted the UI promise that provider-native history
would be retained.

## Decision

- Deleting a Solo Session disconnects its active ACP actor and removes only the
  Kubecode conversation, revisions, runs, and normalized events.
- Removing a Teammate or disbanding a Team removes only Team coordination and
  Kubecode Session records. It releases task assignments and never requests
  provider-native Session deletion.
- Provider Session IDs may be removed from Kubecode with their conversation,
  but the provider remains the owner of its native history.
- Historical pending `provider_cleanup` lifecycle operations are marked
  complete without invoking ACP or a provider CLI. New operations of that kind
  are never created or exposed for retry.
- Project directories and files remain untouched by every Session and Team
  removal path.

## Consequences

`Delete` consistently means “remove from Kubecode.” Users can later import the
same provider-native Session when the Agent exposes it. Kubecode no longer
needs provider delete capability detection, OpenCode delete fallbacks, cleanup
retry UI, or deletion-specific provider error handling.

Provider-native history can only be deleted through the provider's own CLI or
UI, outside Kubecode.
