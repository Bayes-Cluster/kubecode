import type {
  AgentDescriptor,
  AgentId,
  AgentRun,
  AgentSessionState,
  AgentEvent,
  Channel,
  ChannelMessage,
  ChannelMessagePage,
  DmShareRequest,
  TaskBoard,
  TaskDetail,
  TaskDraft,
  TaskReviewRecord,
  WorkOutcome,
  DmSharePreview,
  DmTurn,
  ChannelThread,
  ComposerContextKind,
  ComposerContextRegistration,
  ComposerContextSelector,
  ComposerContextValidationResponse,
  Conversation,
  ConversationHistoryPage,
  ConversationRevision,
  DirectoryListing,
  Entry,
  ExecutionMode,
  GitDiffContextList,
  GitDiffResult,
  GitMutation,
  GitStatus,
  NewChannelMessage,
  Project,
  ProjectContextDetail,
  ProjectContextDocument,
  ProjectContextKind,
  ProjectContextPage,
  ProjectContextRef,
  ProjectContextResolved,
  PromptQueueItem,
  RunAdmission,
  ProviderSessionInfo,
  IlinkLoginPoll,
  IlinkLoginStart,
  IlinkQuickPrompt,
  IlinkQuickPrompts,
  IlinkStatus,
  RuntimeStatus,
  SessionEvent,
  SideQuestionAccepted,
  StartTeamInput,
  StructuredComposerRunRequest,
  ResearchBrief,
  CaptureResearchFindingsRequest,
  ExecutionEnvelope,
  ExecutionEnvelopeLimits,
  ExperimentLogTail,
  ExperimentView,
  LaunchExperimentRequest,
  CaptureResearchFindingsResponse,
  CreateResearchImportRequest,
  ResearchBriefPatch,
  ResearchDetail,
  ResearchExportPacket,
  ResearchImport,
  ResearchImportDetail,
  ResearchPacketSectionId,
  ResearchEntry,
  ResearchExecution,
  ResearchFinding,
  ResearchLinkKind,
  ResearchLinkRole,
  ResearchOutcome,
  ResearchProposal,
  ResearchReviewDecision,
  ResearchRevision,
  ResearchRound,
  ResearchRevisionSummary,
  ResearchSummary,
  StartResearchRoundRequest,
  Team,
  TeamSnapshot,
  TeamWorkspace,
  TerminalInfo,
  TerminalKind,
  TextDocument,
  WorkBoard,
  WorkBoardFilter,
  WorkCard,
  Member,
  MemberDefaults,
  MemberInput,
  MemberPatch,
  MemberRoster,
  MemberSpec,
  WorkCommand,
  WorkDecisionRequest,
  WorkDetail,
  WorkspaceMigrationPreview,
  WorkspaceMigrationResolution,
  WorkspaceMigrationResult,
} from './types'
import { query } from './queries'

function dmShareBody(share: DmShareRequest) {
  return {
    run_ids: share.runIds,
    note: share.note,
    task_id: share.taskId ?? undefined,
    digest: share.digest,
    client_message_id: share.clientMessageId,
  }
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly stage: string | null
  /** Optional categorical refinement of `code` (e.g. why a binding was refused). */
  readonly reason: string | null

  constructor(
    code: string,
    message: string,
    status: number,
    stage: string | null = null,
    reason: string | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.stage = stage
    this.reason = reason
  }
}

export function apiBasePath(pathname: string): string {
  const prefix = pathname.replace(/\/+$/, '')
  return `${prefix === '/' ? '' : prefix}/api/v1`
}

export class KubecodeApi {
  readonly basePath: string

  constructor(basePath = window.location.pathname) {
    this.basePath = apiBasePath(basePath)
  }

  listProjects(): Promise<Project[]> {
    return this.request('/projects')
  }

  listDirectories(path?: string): Promise<DirectoryListing> {
    return this.request(`/filesystem/directories?${query({ path })}`)
  }

  createProject(path: string): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify({ kind: 'create', path }),
    })
  }

  importProject(path: string): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify({ kind: 'import', path }),
    })
  }

  unregisterProject(projectId: string): Promise<void> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  }

  setProjectWorkspacesEnabled(projectId: string, enabled: boolean): Promise<Project> {
    return this.request(`${this.projectPath(projectId)}/workspaces`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  }

  getWorkspaceMigration(projectId: string): Promise<WorkspaceMigrationPreview> {
    return this.request(`${this.projectPath(projectId)}/workspaces/migration`)
  }

  migrateProjectWorkspaces(
    projectId: string,
    resolutions: WorkspaceMigrationResolution[],
  ): Promise<WorkspaceMigrationResult> {
    return this.request(`${this.projectPath(projectId)}/workspaces/migration`, {
      method: 'POST',
      body: JSON.stringify({ resolutions }),
    })
  }

  listEntries(projectId: string, path = ''): Promise<Entry[]> {
    return this.request(`${this.projectPath(projectId)}/entries?${query({ path })}`)
  }

  listSessionEntries(conversationId: string, path = '', signal?: AbortSignal): Promise<Entry[]> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/entries?${query({ path })}`,
      { signal },
    )
  }

  createEntry(projectId: string, path: string, kind: Entry['kind']): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/entries`, {
      method: 'POST',
      body: JSON.stringify({ path, kind }),
    })
  }

  renameEntry(projectId: string, from: string, to: string): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/entries`, {
      method: 'PATCH',
      body: JSON.stringify({ from, to }),
    })
  }

  deleteEntry(projectId: string, path: string): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/entries?${query({ path })}`, {
      method: 'DELETE',
    })
  }

  readFile(projectId: string, path: string): Promise<TextDocument> {
    return this.request(`${this.projectPath(projectId)}/file?${query({ path })}`)
  }

  writeFile(projectId: string, path: string, content: string, revision: string): Promise<TextDocument> {
    return this.request(`${this.projectPath(projectId)}/file?${query({ path })}`, {
      method: 'PUT',
      body: JSON.stringify({ content, revision }),
    })
  }

  gitStatus(projectId: string, signal?: AbortSignal): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/status`, { signal })
  }

  initializeGit(projectId: string): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/init`, { method: 'POST' })
  }

  gitDiff(
    projectId: string,
    path: string,
    staged: boolean,
    signal?: AbortSignal,
  ): Promise<GitDiffResult> {
    return this.request<GitDiffResult>(
      `${this.projectPath(projectId)}/git/diff?${query({ path, staged: String(staged) })}`,
      { signal },
    )
  }

  mutateGit(projectId: string, action: GitMutation, paths: string[]): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/mutate`, {
      method: 'POST',
      body: JSON.stringify({ action, paths }),
    })
  }

  commitGit(projectId: string, message: string): Promise<GitStatus> {
    return this.request(`${this.projectPath(projectId)}/git/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
  }

  listAgents(): Promise<AgentDescriptor[]> {
    return this.request('/agents')
  }

  refreshAgents(): Promise<AgentDescriptor[]> {
    return this.request('/agents/refresh', { method: 'POST' })
  }

  runtimeStatus(): Promise<RuntimeStatus> {
    return this.request('/runtime/status')
  }

  ilinkStatus(): Promise<IlinkStatus> {
    return this.request('/ilink/status')
  }

  ilinkStartLogin(): Promise<IlinkLoginStart> {
    return this.request('/ilink/login/qr', { method: 'POST' })
  }

  ilinkPollLogin(): Promise<IlinkLoginPoll> {
    return this.request('/ilink/login/qr/poll')
  }

  ilinkVerify(code: string, generation: number | null): Promise<void> {
    return this.request('/ilink/login/verify', {
      method: 'POST',
      body: JSON.stringify({ code, generation }),
    })
  }

  ilinkCancelLogin(): Promise<void> {
    return this.request('/ilink/login/cancel', { method: 'POST' })
  }

  ilinkReconnect(): Promise<void> {
    return this.request('/ilink/reconnect', { method: 'POST' })
  }

  ilinkDisconnect(): Promise<void> {
    return this.request('/ilink/disconnect', { method: 'POST' })
  }

  ilinkBindSession(conversationId: string): Promise<{ bound_conversation_id: string | null }> {
    return this.request('/ilink/session-binding', {
      method: 'PUT',
      body: JSON.stringify({ conversation_id: conversationId }),
    })
  }

  ilinkUnbindSession(): Promise<{ bound_conversation_id: string | null }> {
    return this.request('/ilink/session-binding', { method: 'DELETE' })
  }

  ilinkQuickPrompts(): Promise<IlinkQuickPrompts> {
    return this.request('/ilink/quick-prompts')
  }

  ilinkSetQuickPrompt(slot: number, content: string): Promise<IlinkQuickPrompt> {
    return this.request(`/ilink/quick-prompts/${slot}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    })
  }

  ilinkRemoveQuickPrompt(slot: number): Promise<void> {
    return this.request(`/ilink/quick-prompts/${slot}`, { method: 'DELETE' })
  }

  workBoard(projectId: string, filter: WorkBoardFilter = {}): Promise<WorkBoard> {
    return this.request(`${this.projectPath(projectId)}/work/board?${query({
      research_id: filter.research_id,
      round_id: filter.round_id,
      team_id: filter.team_id,
      conversation_id: filter.conversation_id,
      thread_id: filter.thread_id,
      condition: filter.condition,
      origin: filter.origin,
      include_closed: filter.include_closed ? 'true' : undefined,
    })}`)
  }

  /** Adds a task as the researcher; a repeated `clientRequestId` returns the same card. */
  createWork(
    projectId: string,
    input: { title: string; description?: string; roundId?: string; threadId?: string; clientRequestId?: string },
  ): Promise<WorkCard> {
    return this.request(`${this.projectPath(projectId)}/work`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        round_id: input.roundId,
        thread_id: input.threadId,
        client_request_id: input.clientRequestId,
      }),
    })
  }

  workDetail(projectId: string, workId: string): Promise<WorkDetail> {
    return this.request(`${this.projectPath(projectId)}/work/${encodeURIComponent(workId)}`)
  }

  /** The Workspace roster; the first read of an older Workspace gives it its General Agent. */
  listMembers(projectId: string, includeRemoved = false): Promise<MemberRoster> {
    return this.request(`${this.projectPath(projectId)}/members${includeRemoved ? '?include_removed=true' : ''}`)
  }

  createMember(projectId: string, input: MemberInput): Promise<Member> {
    return this.request(`${this.projectPath(projectId)}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  updateMember(projectId: string, memberId: string, expectedRevision: number, patch: MemberPatch): Promise<Member> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, expected_revision: expectedRevision }),
    })
  }

  removeMember(projectId: string, memberId: string): Promise<Member> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}`, {
      method: 'DELETE',
    })
  }

  /** Gives a member a fresh Session (optionally another provider); its old Session loses its authority. */
  replaceMemberSession(projectId: string, memberId: string, spec?: MemberSpec): Promise<Member> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}/session`, {
      method: 'POST',
      body: JSON.stringify(spec ? { spec } : {}),
    })
  }

  /** Opens the researcher's private conversation with a member (created on first use). */
  openMemberDm(projectId: string, memberId: string): Promise<Member> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}/dm`, {
      method: 'POST',
    })
  }

  memberDmTurns(projectId: string, memberId: string): Promise<DmTurn[]> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}/dm/turns`)
  }

  /** Sends to the member privately; nothing is posted to General. A repeated client id replays. */
  sendMemberDm(projectId: string, memberId: string, text: string, clientMessageId: string): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}/dm/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, client_message_id: clientMessageId }),
    })
  }

  /** What sharing these turns would post to General, word for word. Posts nothing. */
  previewDmShare(projectId: string, memberId: string, share: DmShareRequest): Promise<DmSharePreview> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}/dm/share/preview`, {
      method: 'POST',
      body: JSON.stringify(dmShareBody(share)),
    })
  }

  /** Posts the previewed text to General as the researcher; refused if it changed since the preview. */
  shareDm(projectId: string, memberId: string, share: DmShareRequest): Promise<ChannelMessage> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}/dm/share`, {
      method: 'POST',
      body: JSON.stringify(dmShareBody(share)),
    })
  }

  retryMemberSetup(projectId: string, memberId: string): Promise<Member> {
    return this.request(`${this.projectPath(projectId)}/members/${encodeURIComponent(memberId)}/setup`, {
      method: 'POST',
    })
  }

  memberDefaults(): Promise<MemberDefaults> {
    return this.request('/member-defaults')
  }

  saveMemberDefaults(expectedRevision: number, defaults: Pick<MemberDefaults, 'general' | 'templates'>): Promise<MemberDefaults> {
    return this.request('/member-defaults', {
      method: 'PUT',
      body: JSON.stringify({ ...defaults, expected_revision: expectedRevision }),
    })
  }

  /** Answers a question an agent put about a task; the answer grants nothing. */
  answerWorkDecision(
    projectId: string,
    workId: string,
    requestId: string,
    answer: string,
  ): Promise<WorkDecisionRequest> {
    return this.request(
      `${this.projectPath(projectId)}/work/${encodeURIComponent(workId)}/decisions/${encodeURIComponent(requestId)}/answer`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    )
  }

  /** A researcher command; refused if the card changed since `expectedStateRevision`. */
  workCommand(
    projectId: string,
    workId: string,
    expectedStateRevision: number,
    command: WorkCommand,
  ): Promise<WorkCard> {
    return this.request(
      `${this.projectPath(projectId)}/work/${encodeURIComponent(workId)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify({ ...command, expected_state_revision: expectedStateRevision }),
      },
    )
  }

  listChannels(projectId: string): Promise<Channel[]> {
    return this.request(`${this.projectPath(projectId)}/channels`)
  }

  /** One message by id, so a link to it can land on it however old it is. */
  getChannelMessage(projectId: string, channelId: string, messageId: string): Promise<ChannelMessage> {
    return this.request(
      `${this.projectPath(projectId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    )
  }

  /** The Workspace's one board of admitted Tasks (ADR 0221). */
  taskBoard(projectId: string): Promise<TaskBoard> {
    return this.request(`${this.projectPath(projectId)}/tasks/board`)
  }

  /** One Task: its card, brief, provenance, internal work, review, and stale evidence. */
  taskDetail(projectId: string, researchId: string): Promise<TaskDetail> {
    return this.request(`${this.projectPath(projectId)}/tasks/${encodeURIComponent(researchId)}`)
  }

  /**
   * The researcher's decision on a Task's results: accept (choosing the
   * scientific outcome; a well-supported negative result completes a Task) or
   * send back. Refused with `work_evidence_stale` while cited evidence changed.
   */
  reviewTask(
    projectId: string,
    researchId: string,
    decision: { requestId: string; accept: boolean; outcome?: WorkOutcome; reason?: string },
  ): Promise<TaskReviewRecord> {
    return this.request(`${this.projectPath(projectId)}/tasks/${encodeURIComponent(researchId)}/review`, {
      method: 'POST',
      body: JSON.stringify({
        request_id: decision.requestId,
        accept: decision.accept,
        outcome: decision.outcome,
        reason: decision.reason,
      }),
    })
  }

  /** Accepts the current version of one cited result, after looking at what changed. */
  repinTaskEvidence(projectId: string, researchId: string, workId: string, resultId: string): Promise<void> {
    return this.request(`${this.projectPath(projectId)}/tasks/${encodeURIComponent(researchId)}/repin`, {
      method: 'POST',
      body: JSON.stringify({ work_id: workId, result_id: resultId }),
    })
  }

  /** Proposals that are not on the board. */
  taskDrafts(projectId: string): Promise<TaskDraft[]> {
    return this.request(`${this.projectPath(projectId)}/tasks/drafts`)
  }

  listChannelMessages(
    projectId: string,
    channelId: string,
    options: {
      threadId?: string | null
      taskId?: string | null
      beforeSeq?: number
      afterSeq?: number
      limit?: number
    } = {},
  ): Promise<ChannelMessagePage> {
    return this.request(
      `${this.projectPath(projectId)}/channels/${encodeURIComponent(channelId)}/messages?${query({
        thread_id: options.threadId ?? undefined,
        task_id: options.taskId ?? undefined,
        before_seq: options.beforeSeq,
        after_seq: options.afterSeq,
        limit: options.limit,
      })}`,
    )
  }

  /** Posts as the researcher; the server sets attribution. A repeated client id replays. */
  postChannelMessage(
    projectId: string,
    channelId: string,
    message: NewChannelMessage,
  ): Promise<ChannelMessage> {
    return this.request(
      `${this.projectPath(projectId)}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          body: message.body,
          thread_id: message.threadId ?? undefined,
          client_message_id: message.clientMessageId,
          intent: message.intent,
          mentions: message.mentions,
          references: message.references,
          reply_to: message.replyTo ?? undefined,
        }),
      },
    )
  }

  listChannelThreads(
    projectId: string,
    channelId: string,
    researchId?: string,
  ): Promise<ChannelThread[]> {
    return this.request(
      `${this.projectPath(projectId)}/channels/${encodeURIComponent(channelId)}/threads?${query({
        research_id: researchId,
      })}`,
    )
  }

  startChannelThread(
    projectId: string,
    channelId: string,
    rootMessageId: string,
    title?: string,
  ): Promise<ChannelThread> {
    return this.request(
      `${this.projectPath(projectId)}/channels/${encodeURIComponent(channelId)}/threads`,
      { method: 'POST', body: JSON.stringify({ root_message_id: rootMessageId, title }) },
    )
  }

  /** Links a Thread to a question (and round), or unlinks it with nulls. Revision-checked. */
  linkChannelThread(
    projectId: string,
    threadId: string,
    expectedRevision: number,
    researchId: string | null,
    roundId: string | null = null,
  ): Promise<ChannelThread> {
    return this.request(
      `${this.projectPath(projectId)}/threads/${encodeURIComponent(threadId)}/link`,
      {
        method: 'PUT',
        body: JSON.stringify({
          expected_revision: expectedRevision,
          research_id: researchId,
          round_id: roundId,
        }),
      },
    )
  }

  listResearch(projectId: string, includeArchived = false): Promise<ResearchSummary[]> {
    return this.request(`${this.projectPath(projectId)}/research${includeArchived ? `?${query({ archived: 'true' })}` : ''}`)
  }

  createResearch(
    projectId: string,
    brief: Partial<ResearchBrief> & Pick<ResearchBrief, 'title' | 'question'>,
    clientRequestId?: string,
  ): Promise<ResearchDetail> {
    return this.request(`${this.projectPath(projectId)}/research`, {
      method: 'POST',
      body: JSON.stringify({ ...brief, client_request_id: clientRequestId }),
    })
  }

  getResearch(projectId: string, researchId: string): Promise<ResearchDetail> {
    return this.request(this.researchPath(projectId, researchId))
  }

  /** Edits the brief under an optimistic revision check (409 on a stale revision). */
  updateResearch(
    projectId: string,
    researchId: string,
    expectedRevision: number,
    patch: ResearchBriefPatch,
    note?: string,
    /** The imported discussion this edit was reviewed from, for attribution. */
    importId?: string,
  ): Promise<ResearchDetail> {
    return this.request(this.researchPath(projectId, researchId), {
      method: 'PATCH',
      body: JSON.stringify({
        ...patch,
        expected_revision: expectedRevision,
        note,
        import_id: importId,
      }),
    })
  }

  listResearchImports(projectId: string, researchId: string): Promise<ResearchImport[]> {
    return this.request(`${this.researchPath(projectId, researchId)}/imports`)
  }

  /** Stores text as source material; it starts no Agent and changes no brief. */
  createResearchImport(
    projectId: string,
    researchId: string,
    request: CreateResearchImportRequest,
  ): Promise<ResearchImport & { created: boolean }> {
    return this.request(`${this.researchPath(projectId, researchId)}/imports`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  getResearchImport(
    projectId: string,
    researchId: string,
    importId: string,
  ): Promise<ResearchImportDetail> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/imports/${encodeURIComponent(importId)}`,
    )
  }

  /** A bounded discussion packet to preview; nothing leaves until the researcher copies it. */
  exportResearchPacket(
    projectId: string,
    researchId: string,
    sections?: ResearchPacketSectionId[],
  ): Promise<ResearchExportPacket> {
    const params = sections ? `?${query({ sections: sections.join(',') })}` : ''
    return this.request(`${this.researchPath(projectId, researchId)}/export${params}`)
  }

  /** Idempotent state commands; none of them creates a brief revision. */
  setResearchState(
    projectId: string,
    researchId: string,
    action: 'archive' | 'restore' | 'resolve' | 'reopen',
  ): Promise<ResearchDetail> {
    return this.request(`${this.researchPath(projectId, researchId)}/${action}`, { method: 'POST' })
  }

  listResearchEntries(
    projectId: string,
    researchId: string,
    afterSeq = 0,
    limit?: number,
  ): Promise<ResearchEntry[]> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/entries?${query({ after_seq: afterSeq, limit })}`,
    )
  }

  /** Records a researcher note or decision; the server sets attribution. */
  addResearchEntry(
    projectId: string,
    researchId: string,
    kind: 'note' | 'decision',
    body: string,
    clientRequestId?: string,
  ): Promise<ResearchEntry> {
    return this.request(`${this.researchPath(projectId, researchId)}/entries`, {
      method: 'POST',
      body: JSON.stringify({ kind, body, client_request_id: clientRequestId }),
    })
  }

  listResearchRevisions(projectId: string, researchId: string): Promise<ResearchRevisionSummary[]> {
    return this.request(`${this.researchPath(projectId, researchId)}/revisions`)
  }

  getResearchRevision(
    projectId: string,
    researchId: string,
    revision: number,
  ): Promise<ResearchRevision> {
    return this.request(`${this.researchPath(projectId, researchId)}/revisions/${revision}`)
  }

  listResearchRounds(projectId: string, researchId: string): Promise<ResearchRound[]> {
    return this.request(`${this.researchPath(projectId, researchId)}/rounds`)
  }

  getResearchRound(projectId: string, researchId: string, roundId: string): Promise<ResearchRound> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/rounds/${encodeURIComponent(roundId)}`,
    )
  }

  /**
   * The explicit "do work" request. Creating a round is the only research
   * action that starts an Agent or Team; saving, discussing, and linking
   * never do. Safe to retry with the same `client_request_id`.
   */
  startResearchRound(
    projectId: string,
    researchId: string,
    request: StartResearchRoundRequest,
  ): Promise<ResearchRound> {
    return this.request(`${this.researchPath(projectId, researchId)}/rounds`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  /** Continues an unfinished round from its last durable phase. */
  resumeResearchRound(projectId: string, researchId: string, roundId: string): Promise<ResearchRound> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/rounds/${encodeURIComponent(roundId)}/resume`,
      { method: 'POST' },
    )
  }

  /** Read-only discovery over a Project's research, Sessions, Teams, and experiments. */
  searchProjectContext(
    projectId: string,
    options: { query?: string; kinds?: ProjectContextKind[]; limit?: number; cursor?: string } = {},
  ): Promise<ProjectContextPage> {
    const params = query({
      q: options.query || undefined,
      kinds: options.kinds?.length ? options.kinds.join(',') : undefined,
      limit: options.limit,
      cursor: options.cursor,
    })
    return this.request(`${this.projectPath(projectId)}/context/search${params ? `?${params}` : ''}`)
  }

  /** A progressive read: summary first, then content, then evidence. */
  readProjectContext(
    projectId: string,
    ref: ProjectContextRef,
    detail: ProjectContextDetail = 'summary',
    cursor?: string,
  ): Promise<ProjectContextDocument> {
    const params = query({ kind: ref.kind, id: ref.id, revision: ref.revision ?? undefined, detail, cursor })
    return this.request(`${this.projectPath(projectId)}/context/read?${params}`)
  }

  /** Current availability and revision of up to 32 references. */
  resolveProjectContext(projectId: string, refs: ProjectContextRef[]): Promise<ProjectContextResolved[]> {
    return this.request(`${this.projectPath(projectId)}/context/resolve`, {
      method: 'POST',
      body: JSON.stringify({ refs }),
    })
  }

  getResearchExecution(projectId: string, researchId: string, roundId: string): Promise<ResearchExecution> {
    return this.request(this.executionPath(projectId, researchId, roundId))
  }

  /** Creates (no revision) or revises the round's envelope; 409 on a stale revision. */
  setResearchEnvelope(
    projectId: string,
    researchId: string,
    roundId: string,
    limits: ExecutionEnvelopeLimits,
    expectedRevision?: number,
  ): Promise<ExecutionEnvelope> {
    return this.request(`${this.executionPath(projectId, researchId, roundId)}/envelope`, {
      method: 'PUT',
      body: JSON.stringify({ limits, expected_revision: expectedRevision }),
    })
  }

  /** Pause stops future launches only; running processes are not touched. */
  setResearchExecutionState(
    projectId: string,
    researchId: string,
    roundId: string,
    action: 'pause' | 'resume',
  ): Promise<ExecutionEnvelope> {
    return this.request(`${this.executionPath(projectId, researchId, roundId)}/${action}`, {
      method: 'POST',
    })
  }

  /** The researcher's own launch, inside the same envelope an Agent is held to. */
  launchExperiment(
    projectId: string,
    researchId: string,
    roundId: string,
    request: LaunchExperimentRequest,
  ): Promise<ExperimentView> {
    return this.request(`${this.executionPath(projectId, researchId, roundId)}/experiments`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  /** Stops one experiment's process group; the cancelled result is delivered as usual. */
  cancelExperiment(projectId: string, researchId: string, experimentId: string): Promise<ExperimentView> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/experiments/${encodeURIComponent(experimentId)}/cancel`,
      { method: 'POST' },
    )
  }

  /** Stops every running process of the round and closes its envelope. */
  cancelResearchExecution(
    projectId: string,
    researchId: string,
    roundId: string,
  ): Promise<{ cancelled: number; envelope: ExecutionEnvelope }> {
    return this.request(`${this.executionPath(projectId, researchId, roundId)}/cancel`, {
      method: 'POST',
    })
  }

  /** A bounded tail of the experiment's output. */
  getExperimentLog(
    projectId: string,
    researchId: string,
    experimentId: string,
    stream: 'stdout' | 'stderr' = 'stdout',
  ): Promise<ExperimentLogTail> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/experiments/${encodeURIComponent(experimentId)}/logs?${query({ stream })}`,
    )
  }

  /** States what really happened to an `unknown` experiment; nothing is relaunched. */
  reconcileExperiment(
    projectId: string,
    researchId: string,
    experimentId: string,
    truth: 'not_started' | 'finished',
    exitCode?: number,
  ): Promise<ExperimentView> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/experiments/${encodeURIComponent(experimentId)}/reconcile`,
      { method: 'POST', body: JSON.stringify({ truth, exit_code: exitCode }) },
    )
  }

  listResearchFindings(projectId: string, researchId: string): Promise<ResearchFinding[]> {
    return this.request(`${this.researchPath(projectId, researchId)}/findings`)
  }

  /** Records what a linked Session or Team produced, attributed to the researcher. */
  captureResearchFindings(
    projectId: string,
    researchId: string,
    request: CaptureResearchFindingsRequest,
  ): Promise<CaptureResearchFindingsResponse> {
    return this.request(`${this.researchPath(projectId, researchId)}/findings`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  listResearchOutcomes(projectId: string, researchId: string): Promise<ResearchOutcome[]> {
    return this.request(`${this.researchPath(projectId, researchId)}/outcomes`)
  }

  /** States that a completed Team has nothing to record. */
  declineResearchOutcome(
    projectId: string,
    researchId: string,
    teamId: string,
  ): Promise<ResearchOutcome> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/outcomes/${encodeURIComponent(teamId)}/decline`,
      { method: 'POST' },
    )
  }

  listResearchProposals(projectId: string, researchId: string): Promise<ResearchProposal[]> {
    return this.request(`${this.researchPath(projectId, researchId)}/proposals`)
  }

  /** Accepting records a decision; the researcher still edits the brief separately. */
  reviewResearchProposal(
    projectId: string,
    researchId: string,
    entryId: string,
    decision: ResearchReviewDecision,
    note?: string,
  ): Promise<ResearchProposal> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/proposals/${encodeURIComponent(entryId)}/review`,
      { method: 'POST', body: JSON.stringify({ decision, note }) },
    )
  }

  /** Associates a Session or Team; never starts work. */
  linkResearch(
    projectId: string,
    researchId: string,
    kind: ResearchLinkKind,
    refId: string,
    role: ResearchLinkRole,
  ): Promise<ResearchDetail> {
    return this.request(`${this.researchPath(projectId, researchId)}/links`, {
      method: 'POST',
      body: JSON.stringify({ kind, ref_id: refId, role }),
    })
  }

  unlinkResearch(
    projectId: string,
    researchId: string,
    kind: ResearchLinkKind,
    refId: string,
  ): Promise<ResearchDetail> {
    return this.request(
      `${this.researchPath(projectId, researchId)}/links/${kind}/${encodeURIComponent(refId)}`,
      { method: 'DELETE' },
    )
  }

  listConversations(projectId: string): Promise<Conversation[]> {
    return this.request(`${this.projectPath(projectId)}/sessions`)
  }

  listSessions(): Promise<Conversation[]> {
    return this.request('/sessions')
  }

  listProviderSessions(projectId: string, agentId: AgentId): Promise<ProviderSessionInfo[]> {
    return this.request(
      `${this.projectPath(projectId)}/agents/${encodeURIComponent(agentId)}/sessions`,
    )
  }

  createConversation(
    projectId: string,
    agentId: AgentId,
    title?: string,
    providerSessionId?: string,
    agentTitle?: string,
    workspaceMode?: ExecutionMode,
  ): Promise<Conversation> {
    return this.request(`${this.projectPath(projectId)}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: agentId,
        agent_title: agentTitle || undefined,
        provider_session_id: providerSessionId || undefined,
        title: title || undefined,
        workspace_mode: workspaceMode === 'worktree' ? workspaceMode : undefined,
      }),
    })
  }

  listTeams(projectId: string): Promise<TeamSnapshot[]> {
    return this.request(`${this.projectPath(projectId)}/teams`)
  }

  getTeam(teamId: string): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}`)
  }

  startTeam(teamId: string, input: StartTeamInput): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/start`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  pauseTeam(teamId: string): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/pause`, { method: 'POST' })
  }

  resumeTeam(teamId: string): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/resume`, { method: 'POST' })
  }

  retryTeamTask(teamId: string, taskId: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/retry`,
      { method: 'POST' },
    )
  }

  cancelTeamTask(teamId: string, taskId: string, reason?: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) },
    )
  }

  assignTeamTask(teamId: string, taskId: string, memberId: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/assign`,
      { method: 'POST', body: JSON.stringify({ member_id: memberId }) },
    )
  }

  removeTeamMember(teamId: string, memberId: string): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    )
  }

  completeTeam(
    teamId: string,
    finalSummary: string,
  ): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        final_summary: finalSummary,
      }),
    })
  }

  resolveTeamUserInput(
    teamId: string,
    requestId: string,
    answer: string,
  ): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/attention/${encodeURIComponent(requestId)}/resolve`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    )
  }

  updateTeamSettings(
    teamId: string,
    memberManagementPolicy: Team['member_management_policy'],
    maxParallelRuns: number,
  ): Promise<TeamSnapshot> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        member_management_policy: memberManagementPolicy,
        max_parallel_runs: maxParallelRuns,
      }),
    })
  }

  resolveTeamProposal(
    teamId: string,
    proposalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<TeamSnapshot> {
    return this.request(
      `/teams/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposalId)}/decision`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    )
  }

  createTeam(
    projectId: string,
    agentId: AgentId,
    leaderName: string,
    title?: string,
    workspace: TeamWorkspace = 'shared',
  ): Promise<TeamSnapshot> {
    return this.request(`${this.projectPath(projectId)}/teams`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: agentId,
        leader_name: leaderName,
        title: title || undefined,
        workspace,
      }),
    })
  }

  promoteToTeam(
    conversationId: string,
    leaderName: string,
    title?: string,
  ): Promise<TeamSnapshot> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/promote-to-team`, {
      method: 'POST',
      body: JSON.stringify({ leader_name: leaderName, title: title || undefined }),
    })
  }

  updateConversation(conversationId: string, manualTitle: string | null): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ manual_title: manualTitle }),
    })
  }

  archiveConversation(conversationId: string, archived: boolean): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    })
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
    })
  }

  forkConversation(conversationId: string): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/fork`, { method: 'POST' })
  }

  branchConversationAtRun(
    conversationId: string,
    runId: string,
    restoreFiles = true,
  ): Promise<Conversation> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(runId)}/branch`,
      { method: 'POST', body: JSON.stringify({ restore_files: restoreFiles }) },
    )
  }

  reviseConversationAtRun(
    conversationId: string,
    runId: string,
  ): Promise<ConversationRevision> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(runId)}/revise`,
      { method: 'POST' },
    )
  }

  listConversationRevisions(conversationId: string): Promise<ConversationRevision[]> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/revisions`)
  }

  createTeamMember(
    conversationId: string,
    agentId: AgentId,
    isolated: boolean,
  ): Promise<Conversation> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/team-members`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId, isolated }),
    })
  }

  /**
   * Admits a plain prompt (#95/#97): the server starts it when the
   * conversation is idle and otherwise queues it durably, so send never
   * fails with 409 while a run is active.
   */
  async startPrompt(
    projectId: string,
    conversationId: string,
    message: string,
    clientMessageId?: string,
  ): Promise<RunAdmission> {
    const body = await this.request<Record<string, unknown>>(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
        }),
      },
    )
    if (
      body.status === 'pending'
      && typeof body.content === 'string'
      && !('permission_mode' in body)
    ) {
      return { admission: 'queued', item: body as unknown as PromptQueueItem }
    }
    return { admission: 'started', run: body as unknown as AgentRun }
  }

  async startRun(
    projectId: string,
    conversationId: string,
    message: string,
    clientMessageId?: string,
  ): Promise<AgentRun> {
    const admission = await this.startPrompt(projectId, conversationId, message, clientMessageId)
    if (admission.admission === 'queued') {
      // Callers that require an immediately-started run are guarded upstream;
      // reaching here means the guard was bypassed.
      throw new ApiError('active_run', 'a run is already active', 409)
    }
    return admission.run
  }

  startStructuredRun(
    projectId: string,
    conversationId: string,
    request: StructuredComposerRunRequest,
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
    )
  }

  listPromptQueue(conversationId: string): Promise<PromptQueueItem[]> {
    return this.request(`/conversations/${encodeURIComponent(conversationId)}/queue`)
  }

  editPromptQueueItem(
    conversationId: string,
    itemId: string,
    content: string,
  ): Promise<PromptQueueItem> {
    return this.request(
      `/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(itemId)}`,
      { method: 'PATCH', body: JSON.stringify({ content }) },
    )
  }

  async removePromptQueueItem(conversationId: string, itemId: string): Promise<void> {
    await this.request(
      `/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    )
  }

  /** Steer-now (#98): cancels the active run and drains this item next. */
  sendPromptQueueNow(conversationId: string, itemId: string): Promise<PromptQueueItem> {
    return this.request(
      `/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(itemId)}/send-now`,
      { method: 'POST' },
    )
  }

  /** Boundary fork (#100): opens a child conversation cut at the turn. */
  forkFromTurn(conversationId: string, runId: string): Promise<Conversation> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/fork`,
      { method: 'POST' },
    )
  }

  registerComposerContext(
    conversationId: string,
    context: {
      kind: ComposerContextKind
      path: string
      source_revision?: string
      terminal_id?: string
      selected_text?: string
      turn_id?: string
    },
  ): Promise<ComposerContextRegistration> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/composer/contexts`,
      {
        method: 'POST',
        body: JSON.stringify(context),
      },
    )
  }

  listComposerGitDiffs(conversationId: string, signal?: AbortSignal): Promise<GitDiffContextList> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/composer/git-diffs`,
      { signal },
    )
  }

  validateComposerContexts(
    conversationId: string,
    references: ComposerContextSelector[],
  ): Promise<ComposerContextValidationResponse> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/composer/contexts/validate`,
      {
        method: 'POST',
        body: JSON.stringify({ references }),
      },
    )
  }

  dispatchAcpCommand(
    projectId: string,
    conversationId: string,
    name: string,
    commandArguments: string,
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify({ name, arguments: commandArguments }),
      },
    )
  }

  dispatchComposerCommand(
    projectId: string,
    conversationId: string,
    itemId: string,
    catalogRevision: number,
    commandArguments: string,
  ): Promise<AgentRun> {
    return this.request(
      `${this.projectPath(projectId)}/sessions/${encodeURIComponent(conversationId)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          item_id: itemId,
          catalog_revision: catalogRevision,
          arguments: commandArguments,
        }),
      },
    )
  }

  listRuns(conversationId: string): Promise<AgentRun[]> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/runs`)
  }

  getConversationHistory(
    conversationId: string,
    before?: string,
    limit = 50,
  ): Promise<ConversationHistoryPage> {
    return this.request(
      `/sessions/${encodeURIComponent(conversationId)}/history?${query({ before, limit })}`,
    )
  }

  listProjectRuns(projectId: string): Promise<AgentRun[]> {
    return this.request(`${this.projectPath(projectId)}/runs`)
  }

  getRun(runId: string): Promise<AgentRun> {
    return this.request(`/runs/${encodeURIComponent(runId)}`)
  }

  listEvents(runId: string, after = 0): Promise<AgentEvent[]> {
    return this.request(`/runs/${encodeURIComponent(runId)}/events?${query({ after })}`)
  }

  listSessionEvents(conversationId: string, after = 0): Promise<SessionEvent[]> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/events?${query({ after })}`)
  }

  getSessionState(conversationId: string): Promise<AgentSessionState> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/state`)
  }

  askSideQuestion(conversationId: string, question: string): Promise<SideQuestionAccepted> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/side-questions`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    })
  }

  setSessionMode(conversationId: string, value: string): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/options`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'mode', value }),
    })
  }

  setSessionConfig(conversationId: string, configId: string, value: string | boolean): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(conversationId)}/options`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'config', config_id: configId, value }),
    })
  }

  eventStreamUrl(runId: string, after = 0): string {
    return `${this.basePath}/runs/${encodeURIComponent(runId)}/events/stream?${query({ after })}`
  }

  workspaceEventStreamUrl(after = 0): string {
    return `${this.basePath}/events?${query({ after })}`
  }

  workspaceEventCursor(): Promise<number> {
    return this.request<{ cursor: number }>('/events/cursor').then(({ cursor }) => cursor)
  }

  cancelRun(runId: string): Promise<void> {
    return this.request(`/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' })
  }

  resolvePermission(requestId: string, optionId: string): Promise<void> {
    return this.request(`/permissions/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ option_id: optionId }),
    })
  }

  resolveElicitation(
    requestId: string,
    content: Record<string, string | number | boolean | string[]> | null,
  ): Promise<void> {
    return this.request(`/elicitations/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  }

  listTerminals(projectId: string): Promise<TerminalInfo[]> {
    return this.request(`${this.projectPath(projectId)}/terminals`)
  }

  createTerminal(
    projectId: string,
    kind: TerminalKind,
    cols: number,
    rows: number,
    conversationId?: string,
  ): Promise<TerminalInfo> {
    return this.request(`${this.projectPath(projectId)}/terminals`, {
      method: 'POST',
      body: JSON.stringify({ kind, cols, rows, conversation_id: conversationId }),
    })
  }

  closeTerminal(terminalId: string): Promise<void> {
    return this.request(`/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' })
  }

  updateTerminal(terminalId: string, title: string): Promise<TerminalInfo> {
    return this.request(`/terminals/${encodeURIComponent(terminalId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
  }

  terminalSocket(projectId: string, terminalId: string, cursor: number): WebSocket {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const path = `${this.basePath}${this.projectPath(projectId)}/terminals/${encodeURIComponent(terminalId)}/attach`
    return new WebSocket(`${protocol}//${window.location.host}${path}?${query({ cursor })}`)
  }

  private projectPath(projectId: string): string {
    return `/projects/${encodeURIComponent(projectId)}`
  }

  private executionPath(projectId: string, researchId: string, roundId: string): string {
    return `${this.researchPath(projectId, researchId)}/rounds/${encodeURIComponent(roundId)}/execution`
  }

  private researchPath(projectId: string, researchId: string): string {
    return `${this.projectPath(projectId)}/research/${encodeURIComponent(researchId)}`
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body) headers.set('content-type', 'application/json')
    const response = await fetch(`${this.basePath}${path}`, { ...init, headers })
    if (!response.ok) {
      const error = await response.json().catch(() => ({
        code: 'request_failed',
        message: response.statusText || `Request failed (${response.status})`,
      })) as { code?: string; message?: string; stage?: string; reason?: string }
      throw new ApiError(
        error.code ?? 'request_failed',
        error.message ?? `Request failed (${response.status})`,
        response.status,
        error.stage ?? null,
        error.reason ?? null,
      )
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T
    }
    return response.json() as Promise<T>
  }
}
