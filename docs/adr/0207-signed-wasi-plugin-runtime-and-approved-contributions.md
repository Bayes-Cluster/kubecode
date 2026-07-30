---
type: ADR
id: "0207"
title: "Signed WASI plugin runtime and approved contributions"
status: accepted
date: 2026-07-30
---

## Context

ADR 0206 reserves `PluginAction` and `Plugin` catalog values, but deliberately
does not define a plugin runtime. A plugin system would cross Kubecode's package,
process, filesystem, network, credential, Project, Composer, browser, persistence,
and release boundaries. Treating a downloaded executable, npm package, raw tool,
or browser script as a Composer action would let unreviewed code inherit the
server's authority and would make a visible label stand in for authorization.

Kubecode is a standalone Linux application whose active product is the React
browser, Rust server, and packaged assets. It has no official container, hosted
service, marketplace, or built-in multi-user trust boundary. Provider Agents,
their credentials, and their native history remain host-owned. A plugin design
must preserve those boundaries and must work when the browser connects to a
Runtime on another machine.

This ADR decides whether a plugin runtime may be added and defines the minimum
architecture it must satisfy. It does not implement or ship that runtime.

## Decision

Kubecode may add an **optional, Runtime-owned plugin system** in future issues,
using signed, immutable `.kubecode-plugin` packages and WebAssembly components
executed by a separate bounded worker. Installation and permission management
remain separate from Composer selection and invocation. No implementation work
may begin until this ADR is accepted and the relevant follow-up implementation
issues, threat model, and test plans are separately approved.

### Package and manifest

A package is a deterministic ZIP archive using only stored or Deflate entries,
lexicographically ordered UTF-8 paths, and the DOS epoch timestamp. Encryption,
ZIP64, data descriptors, duplicate names, and non-canonical metadata are
rejected. It has these required entries:

- `kubecode-plugin.toml`, parsed by a versioned, deny-unknown manifest schema;
- one WebAssembly Component Model module using the Kubecode plugin WIT world;
- `FILES.sha256`, a sorted SHA-256 inventory of every payload entry other than
  itself and the signature;
- `PUBLISHER.ed25519`, the publisher public key; and
- `SIGNATURE.ed25519`, an Ed25519 signature over the domain-separated message
  `kubecode-plugin-v1\0`, followed by the length and exact bytes of the manifest,
  then the length and exact bytes of `FILES.sha256`.

The manifest declares a reverse-DNS plugin ID, publisher key fingerprint,
semantic version, required Kubecode plugin-API range, localized display
metadata, requested permissions, and every contribution. Contribution
IDs are stable, manifest-local identifiers. The archive may contain bounded
icons and locale bundles, but never native executables, shared libraries,
symlinks, hard links, device files, absolute paths, path traversal, or browser
JavaScript. The Runtime computes the exact archive digest after validation; it
is not declared inside the signed archive, avoiding a circular identity.

Validation happens before extraction. The initial hard ceilings are 32 MiB
compressed, 128 MiB expanded, and 256 archive entries. A failed signature,
digest, schema, compatibility, path, or size check leaves no installed package
or partially updated management record. Validation also requires the manifest
fingerprint to match `PUBLISHER.ed25519` and the signed inventory to contain
every permitted archive payload exactly once with no unlisted entry.

Installed bytes live below Kubecode's XDG data directory in immutable,
content-addressed version directories. The Project directory is never a plugin
installation root, and package installation never modifies Project files.

### Distribution and updates

The first plugin management surface accepts a local package or a bounded upload
to the authenticated Runtime. Kubecode does not operate a marketplace, registry,
repository, update feed, or background downloader. A remote browser uploads the
package to the Runtime that will execute it; it never executes or validates the
component locally.

Updates are explicit package installations. Versions are installed side by side,
validated before activation, and switched atomically per Project. Kubecode does
not auto-update plugins. A new signer, requested permission, contribution kind,
incompatible API range, or major version requires a new approval. Any exact
package change is shown to the user and invalidates old catalog identities even
when the logical contribution ID is unchanged. The prior version remains
available for explicit rollback until the user removes it.

The standalone archive and Debian package do not silently acquire plugins.
Future first-party plugins may be shipped as separately signed packages, but are
subject to the same manifest, compatibility, permission, and contribution rules.

The host advertises one semantic plugin-API version and versioned WIT world.
Plugin-API majors may break imports or behavior; minors are additive and patches
are corrective. A manifest declares a closed inclusive API range and its exact
WIT world. The Runtime never guesses compatibility, rewrites components, or
loads an unsupported package with a compatibility shim. Unsupported installed
versions stay visible but disabled until the user installs a compatible version
or upgrades Kubecode.

### Trust and approval

A valid signature proves package provenance, not safety. Installation requires
interactive approval of the exact package digest and signer. The user may record
a publisher key as trusted for provenance, but each install/update and every
permission increase remains explicit. Key rotation is a new signer and cannot be
accepted from package metadata alone.

Unsigned packages do not run in production. There is no production
`allow-unsigned` switch, environment variable, hidden developer mode, or
manifest escape hatch. Tests may construct in-memory fixtures, but release
artifacts enforce the same signed-package path.

Installation does not enable execution. A package is enabled separately for one
registered Project and one exact package version. There is no implicit global,
all-Project, Session, Team, or Agent enablement. The interactive user owns
install, trust, enable, disable, permission, update, rollback, and uninstall
decisions; Agents, Teams, plugins, Project files, and imported metadata cannot
approve them.

### Runtime and isolation

Plugin code runs as a WebAssembly component inside a dedicated plugin-worker
child process using Wasmtime. It never runs in the Rust server process, provider
Agent process, browser, Node adapter process, or a shell. The worker receives
only a versioned, size-bounded socket-pair protocol with request IDs and a
minimal WIT host interface. One worker serves one exact package version for one
Project; unrelated publishers and Projects never share a worker.

The worker starts with an empty environment, a private working directory, no
inherited standard input, no inherited file descriptors except its protocol
channel, no host filesystem preopens, no socket imports, and no process-spawn or
dynamic-library facility. The server does not pass `HOME`, `PATH`, Project paths,
provider variables, bearer tokens, or proxy variables. The Component Model and
the child-process boundary are both required; either isolation layer being
unavailable disables plugins rather than falling back to native execution.

The worker is also confined by Linux user, mount, PID, and network namespaces,
an empty read-only root with a private temporary directory, `no_new_privs`, a
seccomp syscall allowlist, file-descriptor, process, address-space, and CPU
limits, and no host mounts. This OS boundary is required even though component
code has no ambient WASI imports, because an engine or worker defect must not
regain the invoking user's authority. If the host cannot create every required
namespace or filter, plugin execution is unavailable; Kubecode does not weaken
the sandbox for that machine.

All Project access is a typed host call. The server resolves Project IDs and
validated relative paths through `WorkspaceService` on every operation. Read,
write, list, and Git capabilities are separate permissions; no permission grants
an absolute path or ambient directory handle. Writes retain the same revision,
containment, symlink, and worktree ownership checks as first-party operations.

Version one exposes no network capability. Components receive no WASI sockets,
DNS, HTTP, or proxy interface, and host calls cannot tunnel arbitrary URLs.
Adding allowlisted host-mediated network access requires a superseding ADR with
destination identity, DNS rebinding, redirect, TLS, response-size, audit, and
credential rules.

Version one also exposes no secret store or secret-injection API. Kubecode never
forwards provider credentials, Runtime bearer tokens, Git credentials,
environment secrets, or future Kubecode-managed secrets to the worker, plugin
storage, plugin logs, or plugin analytics. Invocation schemas cannot declare
secret fields, and the core UI offers no credential selection or autofill for
plugin input. A future secret feature must remain host-mediated and must
supersede this ADR; environment-variable or plaintext-file injection is not an
acceptable extension.

Each invocation has Wasmtime fuel/epoch interruption, a wall-clock deadline,
and a cancellation path. The initial ceilings are 128 MiB linear memory, 1 MiB
per request or response, one active invocation per `(Project, plugin)`, and a
queue of at most 32 requests. User actions and panel queries have a five-second
deadline; explicitly approved Agent tools may run for at most 30 seconds. The
worker receives OS resource limits and is terminated on deadline, memory, fuel,
protocol, or output violations. Implementations may lower these limits but may
not raise them without superseding this ADR.

Plugin-private state is host-mediated, namespaced by Project, plugin identity,
and exact major version, and capped at 16 MiB. It is not stored in the Project
directory and is not a secret store; Kubecode never writes or injects Runtime or
provider credentials there. The server owns transactions and quotas; the worker
never opens the state database.

### Permissions

The manifest requests a closed set of versioned capabilities. At minimum, the
model distinguishes Project read, Project write, Git read, Git mutation,
plugin-private state, Agent-callable tools, user-facing actions, suggested
keybindings, and declarative panels. Unknown permissions make a package
incompatible rather than being ignored.

Approval is per Project and records the exact package digest plus the granted
subset. Enabling a plugin cannot grant permissions. Permission review presents
the requested capability, affected Project, contribution that needs it, and
whether it can mutate state. A denied permission disables only dependent
contributions. Plugins cannot request approval during an invocation, disguise a
permission prompt as panel content, or convert a read grant into a write.

### Contribution points

The manifest may declare five contribution types, each with a stable logical
identity `(publisher fingerprint, plugin ID, contribution kind, contribution
ID)`:

- **Tools** are typed Agent-callable operations in a separate server tool
  registry. A raw exported function or discovered tool never becomes a Composer
  item. Tool exposure requires the tool permission and an approved Agent/runtime
  bridge in a follow-up issue.
- **Skills** are explicit user-invocable capability descriptors with a bounded
  input contract and one registered server-side plugin resolver. Only declared,
  enabled, approved skills may enter the typed catalog as `Skill` items.
- **User-facing actions** are explicit commands with localized title,
  description, scope, input schema, required permissions, and invocation/result
  contract. Only these may enter the catalog as `PluginAction` items and the
  global palette.
- **Keybindings** are suggestions that target an approved user-facing action.
  They are inactive until the user assigns them, cannot shadow reserved core
  bindings, and cannot target a raw tool or arbitrary component export.
- **Panels** use a bounded, host-rendered declarative schema and localized
  manifest strings. Components may return structured panel data and receive
  typed user events; they cannot supply HTML, JavaScript, CSS, iframes, webviews,
  React components, or new server routes.

No contribution may register a new coding Agent, hosted model provider,
authentication boundary, filesystem backend, platform target, Tauri surface,
container image, or arbitrary HTTP endpoint. Those remain core product
decisions requiring their own ADRs.

### Composer catalog integration

Plugin management and Composer invocation are separate boundaries. Management
owns package bytes, signer trust, compatibility, Project enablement, permission
grants, worker health, and contribution declarations. It publishes only an
approved safe projection to ADR 0206's existing catalog pipeline.

A catalog item is eligible only when all of these remain true:

1. the exact signed package digest is installed and compatible;
2. that exact version is enabled for the active Session's Project;
3. the contribution is explicitly declared as a skill or user-facing action;
4. every required permission is approved for that Project;
5. the contribution's server-side resolver and input/result schema are
   registered and compatible; and
6. the plugin version is healthy and not quarantined.

The safe item exposes ADR 0206 fields only. Its opaque ID is a digest over the
Session execution namespace, logical contribution identity, exact package
digest, and kind. It is stable across reconnect and server restart, but changes
on every package update so a restored draft cannot silently retarget changed
code. Publisher keys, package paths, component exports, permissions, invocation
payloads, and plugin implementation details remain server-only.

Selection submits the opaque ID, kind, Session, and catalog revision through the
existing structured Composer route. Immediately before dispatch, the server
rechecks package presence, exact digest, Project enablement, permissions,
compatibility, worker health, contribution schema, Session ownership, and
catalog revision. Failure returns an existing stable Composer unavailable,
missing, unsupported, or stale code (`composer_item_disabled`,
`composer_item_missing`, `composer_item_unsupported`, or a stale-revision code)
and never falls back to a same-named item, raw tool, display text, or shell
command.

Update, disable, quarantine, rollback, and uninstall each publish a new full
catalog snapshot for affected Sessions. Existing chips become stale or disabled;
they are never migrated to a different package digest automatically. The global
palette uses the same active-Session projection and revalidation as the Composer.

### Runtime ownership and persistence

The Rust Runtime that owns a Project owns its plugin installation, trust store,
policy, workers, and audit records. The browser is a management client only.
Headless and remote clients use the existing authenticated Runtime boundary;
plugin APIs do not introduce a second listener, token, SSE stream, or trust
store. Generic base-path behavior remains unchanged.

SQLite stores package identity and digest, signer fingerprint, manifest
projection, compatibility, installed versions, active version per Project,
permission grants, contribution health, quarantine state, and audit metadata.
Package bytes and bounded private state live under XDG data paths referenced by
that state. Database records are the authority; directory scanning never enables
a plugin.

Removing a Project unregisters it as usual and disables its plugin policy; it
never deletes the Project directory. Uninstall first disables contributions and
terminates workers. Removing one package version is blocked while any Project
still activates it, then removes only that immutable version's bytes and, after
explicit confirmation, its plugin-private state. It never deletes Project files,
provider-native history, Sessions, or another version. A non-secret audit
tombstone remains so recovery can explain stale catalog items.

At startup the Runtime reconciles records with immutable package digests. A
missing, changed, incompatible, or invalid package is disabled and quarantined,
not reinstalled or executed. An interrupted update keeps the prior active
version. Repeated worker crashes or protocol violations (three within ten
minutes) quarantine the exact package version for that Project until the user
reviews and explicitly re-enables or rolls back it. Plugin failure cannot fail
Runtime startup, health, Projects, Sessions, terminals, or provider Agents.

### Audit and privacy

Local audit rows record timestamp, Runtime-local Project ID, logical plugin and
contribution identity, exact package version/digest, operation, granted
permission names, outcome code, duration, and bounded byte counts. They do not
record arguments, prompt content, filenames, file contents, absolute paths,
panel values, tool input/output, environment values, or credentials. Plugin
stdout/stderr is captured only as bounded diagnostic codes; raw output is not an
analytics source, and the worker cannot obtain inherited host environment data
because none is provided.

Product analytics remain coarser than local audit data: Agent ID where relevant,
item kind, outcome, latency, and bounded counts only. Plugin IDs, names,
publishers, versions, permissions, Project IDs, user input, and all content are
excluded. Plugin code cannot emit Kubecode analytics directly.

### Required implementation gates

This ADR authorizes architecture, not implementation. Before any runtime ships,
separate approved issues must cover at least:

1. package canonicalization, signature verification, trust storage, and archive
   adversarial tests;
2. Wasmtime worker IPC, WIT interfaces, OS limits, cancellation, fuzzing, and an
   independent sandbox threat-model review;
3. Runtime-owned management APIs/UI, Project policy, permission review,
   persistence, update/rollback/uninstall, and recovery;
4. each contribution bridge independently, including catalog/global-palette
   revalidation and proof that raw tools cannot enter either surface; and
5. audit/privacy validation, release packaging for both Linux architectures,
   compatibility tests, and failure/quarantine smoke tests.

Each implementation issue follows Red-Green-Refactor, has its own security and
failure-containment tests, and must preserve the standalone and Debian release
checks. Partial work stays unreachable behind no production route; an in-process,
native, unsigned, or ambient-authority fallback is not allowed.

## Rejected alternatives

- **Native executables, shell scripts, and npm packages:** rejected because they
  inherit ambient server authority and are not portable across both standalone
  architectures.
- **In-process WebAssembly only:** rejected because an engine or host-interface
  defect must not crash or corrupt the Rust Runtime.
- **Unsigned packages or trust-on-first-execution:** rejected because execution
  cannot precede provenance and permission review.
- **Automatic registry discovery and updates:** rejected because Kubecode has no
  marketplace trust, signing, rollback, or remote ownership service.
- **Arbitrary browser panels or iframes:** rejected because they create a second
  web application, origin, CSP, credential, and accessibility boundary.
- **Inferring actions from component exports or tools:** rejected because code
  discovery is not user-facing intent, permission approval, or an invocation
  contract.
- **Passing host credentials into a sandbox:** rejected even with user approval;
  the first runtime has no secret capability.

## Consequences

- Kubecode has a concrete path to third-party extensions without expanding the
  authority of the browser, provider Agents, or downloaded native code.
- Strong isolation and explicit Project grants limit blast radius, but a user
  must still treat approved Project reads/writes and plugin-produced prompt text
  as untrusted behavior from the signed publisher.
- Offline/local package distribution and explicit updates trade convenience for
  auditable provenance, rollback, and remote Runtime ownership.
- Declarative panels and no network or secrets make the first runtime narrower
  than general editor plugin systems. Expanding those powers requires a new ADR.
- Exact package digests in catalog identities make updates intentionally stale
  existing drafts instead of silently changing their meaning.
- The added Wasmtime, package, persistence, and management dependencies remain
  unimplemented until their follow-up issues are approved and accepted.
