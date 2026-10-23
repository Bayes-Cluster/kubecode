# Architecture Decision Records

Only decisions that describe the active Kubecode web product are retained.
ADRs are immutable after acceptance; a later decision supersedes an earlier one.

| ID | Decision |
| --- | --- |
| [0161](0161-kubeflow-web-server-architecture.md) | Kubeflow web server boundary |
| [0162](0162-browser-workbench-and-xterm.md) | Browser workbench, CodeMirror, and xterm |
| [0163](0163-acp-agents-and-splittable-terminal-profiles.md) | ACP Agents and terminal profiles |
| [0164](0164-session-actors-and-global-workspace-events.md) | Session actors and global events |
| [0165](0165-session-first-browser-workbench-and-local-git-review.md) | Session-first workspace and Git review |
| [0166](0166-absolute-project-roots-and-acp-session-state.md) | Absolute Project roots and ACP state |
| [0167](0167-agent-native-permission-controls.md) | Agent-native permission controls |
| [0168](0168-imported-session-hydration-and-project-activity.md) | Imported history and Project activity |
| [0169](0169-terminal-groups-and-browser-snapshots.md) | Terminal groups and snapshots |
| [0170](0170-unified-layout-controls-and-project-file-tree.md) | Layout controls and Project file tree |
| [0171](0171-web-only-repository-boundary.md) | Web-only repository boundary |
| [0172](0172-event-driven-agent-workspace-attention.md) | Event-driven Agent workspace attention |
| [0173](0173-optional-project-workspaces-and-agent-session-cwd.md) | Optional Project Workspaces and Agent Session cwd |
| [0174](0174-immutable-agent-chat-branches.md) | Immutable Agent Chat branches |
| [0175](0175-alternate-index-turn-checkpoints.md) | Alternate-index turn checkpoints |
| [0176](0176-team-members-and-nested-agent-sessions.md) | Team members and nested Agent Sessions |
| [0177](0177-leader-governed-team-sessions-over-acp-mcp.md) | Leader-governed Team Sessions over ACP and MCP |
| [0178](0178-capability-aware-team-mcp-transport.md) | Capability-aware Team MCP transport |
| [0179](0179-agent-native-teammate-configuration-and-lifecycle.md) | Agent-native teammate configuration and lifecycle |
| [0180](0180-provider-native-session-deletion-and-team-disbanding.md) | Provider-native Session deletion and Team disbanding |
| [0181](0181-capability-aware-provider-session-deletion.md) | Capability-aware provider Session deletion |
| [0182](0182-leader-owned-teammate-deletion.md) | Leader-owned teammate deletion |
| [0183](0183-durable-team-runtime-and-member-chat-isolation.md) | Durable Team runtime and member Chat isolation |
| [0184](0184-hidden-agent-chat-revisions.md) | Hidden Agent Chat revisions |
| [0185](0185-leader-reviewed-teammate-permissions.md) | Leader-reviewed teammate permissions |
| [0186](0186-bounded-team-control-plane-and-independent-verification.md) | Bounded Team control plane and independent verification |
| [0187](0187-provider-native-team-permission-profiles.md) | Provider-native Team permission profiles |
| [0188](0188-supervised-team-lifecycle-and-local-first-cleanup.md) | Supervised Team lifecycle and local-first cleanup |
| [0189](0189-agent-first-workbench-visual-hierarchy.md) | Agent-first workbench visual hierarchy |
| [0190](0190-adjustable-workbench-typography-and-view-specific-composition.md) | Adjustable workbench typography and view-specific composition |
| [0191](0191-bounded-session-history-and-multi-document-context.md) | Bounded Session history and multi-document context |
| [0192](0192-local-only-session-removal.md) | Local-only Session removal |
| [0193](0193-opencode-team-permission-environment.md) | OpenCode Team permission environment |
| [0194](0194-standalone-linux-distribution.md) | Standalone Linux distribution |
| [0195](0195-debian-package-distribution.md) | Debian package distribution |
| [0196](0196-dynamic-agent-catalog-and-runtime-doctor.md) | Dynamic Agent catalog and runtime Doctor |
| [0197](0197-session-context-terminal-cwd.md) | Session-context terminal cwd |
| [0198](0198-provider-native-session-mode-ownership.md) | Provider-native Session mode ownership |
| [0199](0199-claude-side-questions-and-consolidated-agent-control.md) | Claude side questions and consolidated Agent control |
| [0200](0200-single-owner-sqlite-and-recoverable-task-cancellation.md) | Single-owner SQLite and recoverable task cancellation |
| [0201](0201-authenticated-headless-runtime-clients.md) | Authenticated headless Runtime clients |
| [0202](0202-managed-runtime-agent-discovery-without-login-shells.md) | Managed Runtime Agent discovery without login shells |
| [0203](0203-batched-agent-runtime-events.md) | Batched Agent Runtime events |
| [0204](0204-bounded-tokio-acp-session-actors.md) | Bounded Tokio ACP Session actors |
| [0205](0205-durable-wake-driven-workspace-event-delivery.md) | Durable wake-driven workspace event delivery |
| [0206](0206-typed-composer-catalog-and-structured-draft.md) | Typed Composer catalog and structured draft |
| [0207](0207-signed-wasi-plugin-runtime-and-approved-contributions.md) | Signed WASI plugin runtime and approved contributions |
| [0208](0208-path-scoped-watched-project-invalidation.md) | Path-scoped watched Project invalidation |
| [0209](0209-semantic-icon-system.md) | Semantic icon system |
| [0210](0210-agent-interaction-model.md) | Agent interaction model: queue, optimistic send, typed stops, boundary fork |
| [0211](0211-wechat-ilink-channel.md) | Rust-owned WeChat iLink channel: protocol authority, durable state, trust boundary, bridge |
| [0212](0212-research-questions-and-continuity.md) | Project-scoped research questions, versioned briefs, and execution continuity |
| [0213](0213-durable-research-experiments.md) | Durable research experiments, waits, and execution envelopes |
| [0214](0214-project-context-discovery.md) | Project context discovery, references, and research handoff |
| [0215](0215-workspace-owned-research-work.md) | Workspace-owned research work, fenced coordination, and one Kanban projection |
| [0216](0216-workspace-conversation-and-research-threads.md) | Shared Workspace conversation with research Threads |
| [0217](0217-orchestrated-research-execution.md) | Orchestrated research execution: routes, round limits, and caller-bound work tools |
| [0218](0218-single-workspace-work-board.md) | One Workspace work board over canonical work records |
| [0219](0219-experiment-analysis-and-evidence-review.md) | Experiment analysis, evidence review, and decisions on native work |
| [0220](0220-workspace-members-and-the-general-agent.md) | Workspace members, the General Agent, and role-bounded authority (§4 provider-tool bound superseded by 0237) |
| [0221](0221-tasks-and-human-authorized-admission.md) | Tasks, and admission authorized by the researcher through the General Agent |
| [0222](0222-shared-workspace-controls-and-composer.md) | Shared Workspace controls and one Composer for General and direct messages |
| [0223](0223-general-conversation-routing-and-direct-messages.md) | One General conversation, routed to members, with private direct messages |
| [0224](0224-workspace-shell-navigation-and-routes.md) | Workspace shell: General, Kanban, Resources, and members, with stable hash routes (partially superseded by 0228) |
| [0225](0225-task-board-inspector-and-browser-acceptance.md) | The Task board, the Task inspector, and browser acceptance with member fixtures |
| [0226](0226-manager-launch-profile-review-routing-and-evidence-pins.md) | The manager's provider launch profile, review decisions routed to the manager, and review evidence pins (§1 superseded by 0237) |
| [0227](0227-workspace-visual-vocabulary.md) | One visual vocabulary for Workspace views: semantic icons, layout tokens, identity, references, and scoped controls |
| [0228](0228-workspace-places-navigation-and-inspector-stack.md) | Workspace places, secondary execution history, and one inspector stack (partially superseded by 0234) |
| [0229](0229-member-identity-member-following-routes-and-one-public-reply.md) | Member identity in the conversation, member-following routes, and one public reply |
| [0230](0230-task-owned-details-review-and-displayed-evidence.md) | Task-owned details, completion only through review, separate archiving, and evidence accepted at a displayed version |
| [0231](0231-workspace-search-file-references-and-versioned-attachments.md) | Workspace search with a named scope, Project files as references, one preview surface, and versioned references |
| [0232](0232-pending-decisions-delivery-state-and-scoped-execution-controls.md) | Pending decisions, message delivery state, and scoped execution controls are server projections |
| [0233](0233-ai-elements-foundation-and-workspace-prototypes.md) | AI Elements as the Workspace component foundation, a Harness-aligned token layer, and fixture prototypes |
| [0234](0234-needs-you-destination-and-one-shell-frame.md) | Needs you as a Workspace destination, one destination header, and a 360-pixel inspector |
| [0236](0236-one-presentation-of-cited-materials.md) | One presentation of cited materials: Sources in messages, readable evidence, and recovery from Resources |
| [0237](0237-manager-permission-authority.md) | The manager runs with full native permissions and reviews specialists' permission requests |
| [0238](0238-one-stop-per-task-and-a-centered-conversation-dock.md) | One Stop per Task, a folded running list, and one centered conversation column |
| [0239](0239-chat-aligned-conversation-wide-thread-quiet-composer.md) | Chat-aligned conversation, a wide thread, and a quiet composer |
| [0240](0240-one-dock-width-and-a-two-line-running-item.md) | One dock width, a two-line running item, and a reading measure on wide panes |
| [0241](0241-official-shadcn-ui-and-ai-elements-as-the-component-layer.md) | Official shadcn/ui and AI Elements as the component layer |
| [0242](0242-general-and-dms-on-the-official-components.md) | General and DMs on the official components |
| [0243](0243-official-components-for-task-inspector-kanban-and-needs-you.md) | Official components for the Task inspector, Kanban and Needs you |
| [0244](0244-resources-and-members-on-official-components.md) | Resources and Members on official shadcn/ui and AI Elements components |
| [0245](0245-session-view-on-official-ai-elements.md) | The Session view on official AI Elements |
| [0246](0246-official-components-cleanup-and-acceptance.md) | Cleanup after the move to official components |
| [0247](0247-official-components-own-base-appearance.md) | Official components own base appearance; shared contract for UI A–I |
| [0248](0248-workspace-shell-on-official-sidebar-sheet-and-resizable.md) | The Workspace shell on the official Sidebar, Sheet and Resizable |
| [0251](0251-tasks-reviews-and-attention-on-official-components.md) | Tasks, reviews, Needs you and execution feedback on official components |
