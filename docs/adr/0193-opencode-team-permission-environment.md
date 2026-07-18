# ADR 0193: OpenCode Team permission environment

## Status

Accepted. Supersedes only the OpenCode environment-variable encoding in ADR
0187. The provider-native Team permission policy and all other mappings in ADR
0187 remain in force.

## Context

OpenCode parses `OPENCODE_PERMISSION` as JSON and deep-merges the decoded value
into its permission object. Passing the JSON scalar `"allow"` decodes to a
string. OpenCode then treats its characters as indexed permission entries,
rejects `permission["0"]`, and reports the resulting ACP initialization failure
as a directory service failure.

## Decision

Kubecode encodes the OpenCode maximum Team permission profile as the JSON object
`{"*":"allow"}` in the process-scoped `OPENCODE_PERMISSION` environment
variable.

Solo and Standard Team Sessions do not receive this override. OpenCode
Discriminator Sessions continue to use the Agent-native `plan` mode and do not
receive the maximum permission profile.

## Consequences

- OpenCode YOLO Leaders and teammates receive a schema-valid process permission
  override.
- ACP directory initialization no longer fails because a permission scalar was
  merged as indexed object entries.
- The environment value remains independently testable without starting a real
  provider Session.
