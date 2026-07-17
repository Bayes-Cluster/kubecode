# ADR 0187: Provider-native Team permission profiles

## Status

Accepted. Supersedes the YOLO permission-selection and provider-mapping
paragraphs in ADR 0186. The Team authority, task, completion, and independent
verification decisions in ADR 0186 remain in force.

## Context

YOLO is a Kubecode Team execution policy, not a provider mode name. Claude
Code, Codex, and OpenCode expose different permission controls, and OpenCode's
ACP mode selector describes Agent profiles rather than filesystem permission.
Matching display labels such as “YOLO”, “auto”, or “full access” is therefore
unsafe and changes meaning across versions. A failed native mapping must also
remain understandable after a browser or server restart.

## Decision

Kubecode stores both the requested Team mode and the effective Team mode. When
YOLO is requested, Kubecode applies an exact provider-native maximum permission
profile:

- Codex ACP configuration `mode = agent-full-access`;
- Claude Code ACP configuration `mode = bypassPermissions`, only when that
  exact value is advertised;
- OpenCode process environment `OPENCODE_PERMISSION = "allow"`.

Model, effort, fast mode, and other non-permission Agent configuration remain
user-controlled. The Team UI hides only the permission mode selector while
YOLO is effective and shows the provider mapping that Kubecode owns.

If a provider does not advertise its required maximum profile because of
version, host, root, or policy restrictions, the entire Team runs in Standard
mode. The record retains `requested_mode = yolo`, the effective Standard mode,
the affected Agent, a stable reason code, a human-readable reason, and the
fallback timestamp. Transport and process failures fail Team startup instead
of being described as a policy fallback.

Each Team member records whether Kubecode applied a native permission profile
and, when available, the previous native mode. Completion and mode fallback
restore those settings and reconnect process-scoped providers. These records
make restoration and UI status independent of an in-memory ACP actor.

The Discriminator is always read-only regardless of Team mode. Kubecode uses
only exact provider controls: Codex `read-only`, Claude Code `plan`, and
OpenCode `plan`. Permission callbacks from a Discriminator remain rejected.

## Consequences

- “YOLO” remains stable product language without pretending every provider has
  a mode with that name.
- OpenCode permission is no longer confused with its Build/Plan Agent profile.
- A restart preserves the distinction between requested autonomy and effective
  execution policy.
- Adding support for another Agent requires an explicit maximum and read-only
  mapping; label heuristics are not accepted.
- Provider changes that remove a known wire value cause a visible Standard
  fallback instead of silently granting a different permission.
