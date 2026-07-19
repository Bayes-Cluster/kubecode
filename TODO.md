# Kubecode TODO

## Kubecode Desktop and remote development

> Status: proposed roadmap. Desktop is not an active platform target yet.
> Implementation must begin with a new ADR that supersedes ADR 0171 and defines
> the desktop runtime, packaging, release, update, and security boundaries.

### Product direction

Kubecode Desktop should follow the VS Code Remote model. The desktop application
is a local client, while a versioned `kubecode-server` runs beside the Project,
Agent CLIs, terminals, Git repository, datasets, and compute resources on the
remote system.

The top-level abstraction is a remote development environment, not a Kubernetes
container. SSH, Slurm, Kubernetes, and a local process are different ways to
reach and allocate that environment.

The intended composition is:

| Environment | Access transport | Resource allocator |
| --- | --- | --- |
| Local development | Local process | Direct |
| Remote workstation or VM | SSH | Direct |
| HPC cluster | SSH to a login node | Slurm |
| Kubernetes or Kubeflow | Kubernetes API | Kubernetes Pod or Notebook |

Later scheduler adapters may support PBS Pro and LSF without changing the
Kubecode Session, Project, Agent, Terminal, or file APIs.

### Architecture boundaries

- [ ] Add an ADR that supersedes ADR 0171 before introducing desktop code.
- [ ] Decide between Tauri and Electron, including code signing, auto-update,
      supported operating systems, WebView/Chromium compatibility, and release
      ownership.
- [ ] Keep the React workbench reusable by browser and desktop clients.
- [ ] Keep `WorkspaceService`, `AgentRuntime`, `TerminalManager`, Git, and
      provider-native Agent processes on the remote runtime.
- [ ] Make the remote Rust server usable without relying on a remotely served UI.
- [ ] Define a versioned client/server protocol and compatibility window.
- [ ] Scope every desktop Project reference by remote environment and runtime;
      the same absolute path on two hosts must not identify the same Project.
- [ ] Keep remote Project path validation behind the remote `WorkspaceService`.
- [ ] Store durable Session metadata on persistent remote storage so a new
      allocation can resume an existing Agent Session.

Proposed composition:

```text
Kubecode Desktop
  -> AccessTransport (local, SSH, Kubernetes API)
  -> ResourceAllocator (direct, Slurm, Kubernetes)
  -> RuntimeTarget (host, compute node, or Pod)
  -> RemoteRuntimeManager
  -> kubecode-server
     -> WorkspaceService
     -> AgentRuntime / ACP
     -> Claude Code / Codex / OpenCode
     -> TerminalManager
     -> Git and file services
```

### Access transport

- [ ] Define an `AccessTransport` abstraction for connect, command execution,
      artifact upload, tunnelling, liveness, and disconnect.
- [ ] Implement `LocalTransport` for development and behavioral tests.
- [ ] Implement `SshTransport` using the system OpenSSH client initially so it
      inherits `~/.ssh/config`, ProxyJump, SSH Agent, host-key verification,
      hardware keys, MFA, and site-specific SSH configuration.
- [ ] Implement `KubernetesTransport` using kubeconfig, Kubernetes exec, watch,
      and port-forward APIs.
- [ ] Do not expose SSH credentials, kubeconfig contents, tokens, certificates,
      prompt content, filenames, or file contents to frontend storage or logs.
- [ ] Add an explicit trust flow for new SSH host keys and Kubernetes cluster
      certificate errors.
- [ ] Design a transport-independent local endpoint so the existing HTTP, SSE,
      and WebSocket protocols can run over SSH or Kubernetes forwarding.
- [ ] Investigate a multiplexed stdio channel for HPC sites that prohibit TCP
      access from login nodes to compute nodes.

### Resource allocation

- [ ] Define a `ResourceAllocator` abstraction for allocate, inspect, reconnect,
      stop, and release.
- [ ] Implement `DirectAllocator` for local and ordinary SSH hosts.
- [ ] Implement `SlurmAllocator` without running long-lived Agent or terminal
      processes on the login node.
- [ ] Implement `KubernetesAllocator` independently of the Kubeflow CRD.
- [ ] Add a Kubeflow specialization that creates `kubeflow.org/v1` Notebook
      resources when the CRD is available.
- [ ] Keep storage deletion separate from runtime deletion. Stopping or deleting
      a runtime must preserve Project files and provider-native Agent history by
      default.

### Remote runtime manager

- [ ] Detect the remote operating system, architecture, shell, available disk,
      and existing Kubecode Server version.
- [ ] Install versioned server artifacts below `~/.kubecode-server/bin/<version>`
      without requiring root privileges.
- [ ] Support downloading the server locally and uploading it to remote systems
      that cannot access the public internet.
- [ ] Verify artifact checksums or signatures before starting an uploaded binary.
- [ ] Bind the remote server only to loopback or a Unix socket and require an
      ephemeral connection token in addition to transport authentication.
- [ ] Add startup handshake, health check, protocol negotiation, upgrade,
      reconnect, log collection, and stale-process cleanup.
- [ ] Keep direct-SSH runtimes alive across a desktop disconnect where remote
      policy permits it; do not depend on an open browser socket for ownership.
- [ ] Preserve the current global event cursor and PTY replay semantics across
      tunnel reconnection.

### Slurm backend

- [ ] Add a Remote profile for login host, account, partition, QoS, reservation,
      CPU, memory, GPU, node constraints, and walltime defaults.
- [ ] Generate a safely quoted batch script and submit it through `sbatch`.
- [ ] Persist the Slurm Job ID and reconcile status through `squeue`, `scontrol`,
      and `sacct` where available.
- [ ] Model `submitting`, `queued`, `allocating`, `starting`, `connected`,
      `suspended`, `preempted`, `completed`, and `failed` states.
- [ ] Start `kubecode-server` on the allocated compute node, not the login node.
- [ ] Have the job publish a connection record containing the Job ID, compute
      host, endpoint, protocol version, and a short-lived connection secret.
- [ ] Support login-node forwarding to the compute node when site policy permits.
- [ ] Support ProxyJump/direct compute-node SSH when enabled by the site.
- [ ] Design an `srun`/stdio relay fallback for clusters that block compute-node
      TCP forwarding.
- [ ] Treat an allocation as replaceable runtime state. Project files, Kubecode
      metadata, and provider session identifiers must live on shared persistent
      storage so a later allocation can resume work.
- [ ] Surface walltime expiry, queue reason, preemption, node failure, and job
      cancellation as durable workspace events.
- [ ] On job loss, mark PTYs as exited and reconnect Agent Sessions through their
      provider-native resume/load capabilities when a new allocation starts.
- [ ] Support native execution, Environment Modules, Conda, and
      Apptainer/Singularity launch profiles, including GPU passthrough.

### Kubernetes and Kubeflow backend

- [ ] Discover kubeconfig contexts and only list namespaces allowed by current
      Kubernetes RBAC.
- [ ] Run preflight capability and `SelfSubjectAccessReview` checks before
      presenting create actions.
- [ ] Support existing Pods before adding workload creation.
- [ ] Create generic Pod/PVC runtimes through `KubernetesAllocator`.
- [ ] Add Notebook, Profile namespace, PodDefault, PVC, ServiceAccount,
      ImagePullSecret, CPU, memory, and GPU support in the Kubeflow specialization.
- [ ] Connect through Kubernetes port-forward by default so a public Ingress is
      not required.
- [ ] Never copy the user's kubeconfig into the remote Pod.
- [ ] Separate Remove from Desktop, Delete Runtime, and Delete Storage actions.

### Desktop experience

- [ ] Add a Remote Explorer inspired by VS Code with Local, SSH, Slurm, and
      Kubernetes groups.
- [ ] Show connection and allocation states consistently across backends.
- [ ] Let the create form render backend-specific fields without leaking those
      fields into the shared Session workspace.
- [ ] Provide SSH host/context selection, connection diagnostics, logs, retry,
      reconnect, stop, and remove actions.
- [ ] Provide Slurm queue position/reason, Job ID, assigned node, resources,
      elapsed time, remaining walltime, and cancellation controls.
- [ ] Provide Kubernetes context, namespace/Profile, Pod/Notebook, resource, and
      event diagnostics.
- [ ] Open the same Agent-first Kubecode workbench after a runtime connects.
- [ ] Keep Claude Code, Codex, and OpenCode authentication on the remote system.
- [ ] Do not automatically copy local `~/.claude`, `~/.codex`, OpenCode, Git, or
      cloud credentials to a remote environment.

### Desktop-only notification channels

IM integrations are outbound notification channels owned exclusively by
Kubecode Desktop. They are not a messaging gateway, an Agent control surface,
or part of a remote Workspace. The existing browser/system notification design
remains unchanged and separate from this feature.

The data flow is:

```text
Remote kubecode-server
  -> durable Workspace Events over SSE
  -> Kubecode Desktop notification policy
  -> local delivery queue
  -> Slack / Telegram / Discord / Feishu / generic webhook
```

#### Product and security boundaries

- [ ] Keep all IM configuration, adapters, credentials, delivery policy, and
      delivery history in the Desktop application.
- [ ] Do not add IM SDKs, bot tokens, webhook configuration, delivery tables, or
      channel-specific behavior to `server/` or the remote Workspace runtime.
- [ ] Do not expose Notification Channel settings in the browser-only Kubecode
      workspace.
- [ ] Store channel secrets in the operating-system Keychain, never in frontend
      storage, Project files, remote SQLite, or a remote environment.
- [ ] Make the integration outbound-only. Do not receive IM messages, prompts,
      slash commands, reactions, callbacks, or thread replies.
- [ ] Do not create, continue, interrupt, steer, stop, or delete Agent Sessions
      from an IM application.
- [ ] Do not allow IM users to answer ACP permissions or elicitation requests.
      An attention notification may only direct the user back to Kubecode.
- [ ] Do not map IM users, chats, channels, groups, or threads to Projects or
      Agent Sessions.
- [ ] Accept that notifications are unavailable while Desktop is fully stopped,
      disconnected, or the computer is asleep in the first release.
- [ ] Do not introduce an always-on remote relay or hosted notification service
      in the first release. If offline delivery becomes a requirement, design an
      optional Kubecode Relay/Hub in a separate ADR rather than adding it to a
      Workspace.

#### Notification events

- [ ] Allow notifications for Agent completion, failure, interruption,
      permission required, elicitation required, and prolonged execution.
- [ ] Allow notifications for SSH disconnects, remote server failures, and
      incompatible runtime versions.
- [ ] Allow notifications for Slurm submission, prolonged queueing, allocation,
      approaching walltime, preemption, cancellation, completion, and failure.
- [ ] Allow notifications for Kubernetes scheduling failure, Pod readiness,
      restart, eviction, termination, and storage/resource errors.
- [ ] Do not deliver tool-call streams, terminal commands or output, file events,
      Git diffs, prompts, or complete Agent responses.
- [ ] Reuse durable Workspace Event IDs as the source of delivery idempotency so
      an SSE reconnect cannot send the same event twice to one channel.

#### Message privacy and navigation

- [ ] Limit default message fields to the configured Remote display name,
      Project display name, Session title, Agent, status, elapsed time, and
      timestamp.
- [ ] Never include absolute paths, credentials, prompt content, file names,
      file contents, terminal commands/output, Git diffs, or the command behind
      a permission request.
- [ ] Support a redacted mode that omits Project and Session titles.
- [ ] Add an optional `kubecode://` deep link containing opaque Remote, Project,
      and Session IDs only.
- [ ] Re-authorize and resolve every deep link inside Desktop. Never encode a
      remote endpoint, path, credential, connection token, or permission
      decision in the link.

#### Adapters and delivery behavior

- [ ] Define a small outbound `NotificationAdapter` contract with capability
      metadata, test delivery, send, and normalized delivery errors.
- [ ] Prefer limited-scope incoming webhooks over full bot credentials where the
      platform supports them.
- [ ] Add Slack Incoming Webhook, Discord Webhook, Feishu/Lark Custom Bot,
      Telegram Bot API, and Generic HTTP Webhook adapters incrementally.
- [ ] Keep formatting capability-driven for Markdown, links, message length, and
      optional rich blocks without normalizing every platform to one payload.
- [ ] Add a bounded local delivery queue with exponential backoff, retry limits,
      timeout, cancellation, and persisted delivery outcome.
- [ ] Use `(workspace_event_id, notification_channel_id)` as an idempotency key.
- [ ] Aggregate repeated connection or runtime errors over a configurable time
      window instead of flooding a channel.
- [ ] Provide a Test Notification action and visible channel health/last-delivery
      status without exposing secret values.

#### Desktop settings

- [ ] Add Notification Channels beneath Desktop notification settings, separate
      from existing system/browser notification preferences.
- [ ] Support global enable/disable, event category filters, quiet hours,
      unfocused-only delivery, minimum run duration, repeated-error aggregation,
      and per-Remote or per-Project overrides.
- [ ] Make every configured destination explicit; never infer a Slack channel,
      Telegram chat, or webhook target from Agent output.
- [ ] Keep all user-facing copy localized and make the outbound-only behavior
      clear in setup and test-delivery UI.

### Delivery phases

#### Phase 0: architecture and protocol spike

- [ ] Superseding ADR accepted.
- [ ] Desktop shell decision recorded.
- [ ] Extract or define the versioned remote protocol boundary.
- [ ] Connect a local client to the existing server through a forwarded local
      endpoint and verify HTTP, SSE, Agent ACP, and terminal WebSockets.

#### Phase 1: Remote SSH

- [ ] Connect to an existing SSH host.
- [ ] Probe, upload, install, start, stop, upgrade, and reconnect
      `kubecode-server`.
- [ ] Open a remote absolute Project path in the desktop workbench.
- [ ] Verify Agent Sessions, file editing, Git, terminal splits, event replay,
      and disconnect recovery.
- [ ] Add the Desktop notification dispatcher and one limited-scope webhook
      adapter after remote Workspace Event reconnection is reliable.

#### Phase 2: Slurm

- [ ] Submit and monitor an interactive Kubecode allocation.
- [ ] Connect through a login node to the assigned compute node.
- [ ] Resume the same Workspace after cancellation, timeout, or preemption.
- [ ] Validate native and Apptainer launch profiles on a representative cluster.

#### Phase 3: Kubernetes and Kubeflow

- [ ] Attach to an existing Pod.
- [ ] Create a generic Pod/PVC Workspace.
- [ ] Create and reconnect a Kubeflow Notebook Workspace.
- [ ] Verify kubeconfig exec authentication, RBAC failures, and port-forward
      recovery.

#### Phase 4: additional schedulers and enterprise policy

- [ ] Add PBS Pro and LSF through the allocator interface.
- [ ] Add centrally managed Remote and runtime templates.
- [ ] Add optional relay support for environments without inbound SSH or direct
      Kubernetes API access.
- [ ] Add signed desktop releases, updates, compatibility gates, and rollback.

### MVP completion criteria

- [ ] One desktop build connects to a normal SSH host and a Slurm cluster without
      changing the Project, Session, Agent, Terminal, Git, or file model.
- [ ] Projects and Agent Sessions survive desktop restart and runtime replacement.
- [ ] Slurm work runs on a compute node and respects scheduler lifecycle and
      walltime.
- [ ] Remote services are not publicly exposed and credentials do not enter the
      frontend or analytics.
- [ ] Failure and reconnect behavior has automated coverage for transport loss,
      server mismatch, allocation timeout, preemption, and stale endpoints.
- [ ] The existing standalone browser release remains supported and does not
      require the desktop application.

### Non-goals for the first desktop release

- Running remote Projects through local Agent binaries.
- Synchronizing an entire remote filesystem onto the desktop.
- Replacing `kubectl`, Slurm administration, or a full cluster management UI.
- Creating Kubeflow Profiles or granting Kubernetes/Slurm permissions.
- Supporting schedulers other than Slurm in the MVP.
- Deleting Project directories or provider-native Agent history.
- Receiving or acting on messages from Slack, Telegram, Discord, Feishu, or any
  other IM platform.
- Delivering IM notifications from a remote Workspace, browser-only deployment,
  or hosted relay while Kubecode Desktop is offline.

### Design references

- [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh): local
  client, remote server installation, forwarding, and reconnect behavior.
- [Open OnDemand Interactive Apps](https://osc.github.io/ood-documentation/latest/how-tos/app-development/interactive/view.html): scheduler-backed interactive jobs and connecting to a web server on an allocated compute node.
- [DevPod provider architecture](https://devpod.sh/docs/managing-providers/what-are-providers): separating workspace behavior from infrastructure providers.
- [Kubeflow Notebooks](https://www.kubeflow.org/docs/components/notebooks/overview/): Kubernetes-native interactive development runtimes.
