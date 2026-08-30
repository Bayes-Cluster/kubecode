import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, RotateCw, Settings } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { AppLocale, Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { availableAcpCommands } from '../acpCommands'
import { nativeSessionOptions } from '../agentSessionOptions'
import type {
  AgentDescriptor,
  AgentSessionState,
  Conversation,
  KubecodeApi,
  TeamSnapshot,
  WorkspaceEvent,
} from '../api'
import type { CommandPaletteSessionSnapshot, RankedCommandPaletteItem } from '../commandPalette'
import { appendComposerCapability, createComposerCapabilityReference } from '../composerDraft'
import { DeleteTeamDialog } from '../DeleteTeamDialog'
import { useSystemMessages } from '../systemMessages'
import { TeamSessionOverview } from '../TeamSessionOverview'
import { TeamWorkspaceView } from '../TeamWorkspaceView'
import type { TerminalContextSource } from '../TerminalWorkspace'

import { PromptQueueDock } from './PromptQueueDock'
import { SessionComposer } from './SessionComposer'
import { SessionTimeline } from './SessionTimeline'
import { SessionTitlebar } from './SessionTitlebar'
import type { SessionPlanEntry } from './SessionPlanSummary'
import {
  agentName,
  availableCommands,
  canAskSideQuestion,
  elicitationContent,
  errorMessage,
  nativeModeLockReason,
  sessionCapability,
  sessionStateWithConfig,
  sessionStateWithMode,
} from './sessionModel'
import { terminalCauseNotice } from './sessionModel'
import { useComposerController } from './useComposerController'
import { useSessionEvents } from './useSessionEvents'
import { useSessionHistory } from './useSessionHistory'
import { useSessionState } from './useSessionState'

type AgentSessionWorkspaceProps = {
  agents: AgentDescriptor[]
  agentsRefreshing?: boolean
  allowTeammateChat?: boolean
  api: KubecodeApi
  conversation: Conversation | null
  locale: AppLocale
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onAddProject?: () => void
  onCommandPaletteSessionChange?: (session: CommandPaletteSessionSnapshot | null) => void
  onNewSession?: () => void
  onOpenAgentSettings?: () => void
  onOpenPlan?: () => void
  onPlanChange?: (entries: SessionPlanEntry[]) => void
  onRefreshAgents?: () => Promise<void>
  onTeamCreated?: (team: TeamSnapshot) => void
  onTeamUpdated?: (team: TeamSnapshot) => void
  onSelectTeamMember?: (conversationId: string) => void
  projectId: string | null
  t: Translator
  workspaceEvents: WorkspaceEvent[]
  team?: TeamSnapshot | null
  terminalContextSources?: TerminalContextSource[]
  titlebarTarget?: HTMLElement | null
}

export function AgentSessionWorkspace({
  agents,
  agentsRefreshing = false,
  allowTeammateChat = false,
  api,
  conversation,
  locale,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onAddProject,
  onCommandPaletteSessionChange,
  onNewSession,
  onOpenAgentSettings,
  onOpenPlan,
  onPlanChange,
  onRefreshAgents,
  onTeamCreated,
  onTeamUpdated,
  onSelectTeamMember,
  projectId,
  terminalContextSources = [],
  t,
  workspaceEvents,
  team,
  titlebarTarget,
}: AgentSessionWorkspaceProps) {
  const [error, setError] = useState<string | null>(null)
  const [workspaceWarning, setWorkspaceWarning] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteTeamOpen, setDeleteTeamOpen] = useState(false)
  const [teamView, setTeamView] = useState<'chat' | 'team'>(
    conversation?.team_role === 'leader' ? 'team' : 'chat',
  )
  const [draftTitle, setDraftTitle] = useState('')
  const conversationId = conversation?.id ?? null
  const [teamViewKey, setTeamViewKey] = useState(() => ({
    conversationId,
    teamRole: conversation?.team_role,
  }))
  const nextTeamViewKey = {
    conversationId,
    teamRole: conversation?.team_role,
  }
  if (teamViewKey.conversationId !== nextTeamViewKey.conversationId
    || teamViewKey.teamRole !== nextTeamViewKey.teamRole) {
    setTeamViewKey(nextTeamViewKey)
    setTeamView(conversation?.team_role === 'leader' ? 'team' : 'chat')
  }
  const systemMessages = useSystemMessages()
  const agent = agents.find((item) => item.id === conversation?.agent_id)
  const agentLabel = conversation ? agentName(conversation.agent_id) : t('kubecode.agent')
  const reportError = useCallback((cause: unknown) => {
    const message = errorMessage(cause, t('kubecode.error'))
    if (systemMessages) {
      systemMessages.publish({ level: 'error', message, source: agentLabel })
    } else {
      setError(message)
    }
  }, [agentLabel, systemMessages, t])

  const sessionState = useSessionState({ api, conversationId })
  const history = useSessionHistory({
    api,
    beginSessionStateRequest: sessionState.beginSessionStateRequest,
    onRunTerminal: (cause) => {
      // Convergence surfacing (#93): quiet for cancellations, errors for
      // resource/refusal failures. Copy is localized; payloads carry no
      // prompt content or paths.
      const notice = terminalCauseNotice(cause, t)
      if (!notice) return
      if (systemMessages) {
        systemMessages.publish({ level: notice.level, message: notice.message, source: agentLabel })
      }
    },
    conversation,
    conversationId,
    directTeammateChatDisabled: conversation?.team_role === 'teammate'
      && !allowTeammateChat,
    hardReadOnly: Boolean(
      conversation?.read_only || conversation?.team_role === 'discriminator',
    ),
    projectId,
    reportError,
    setComposerCatalogLoadFailed: sessionState.setComposerCatalogLoadFailed,
    setWorkspaceWarning,
    t,
  })
  useSessionEvents({
    applySessionStatePayload: sessionState.applySessionStatePayload,
    conversation,
    reportError,
    requestSessionState: sessionState.requestSessionState,
    transcript: history.transcript,
    viewRevisionId: history.viewRevisionId,
    workspaceEvents,
  })

  const transcript = history.transcript
  const {
    active,
    appendOptimisticMessage,
    attachRun,
    elicitationAnswers,
    messages,
    pendingElicitation,
    pendingPermission,
    removeOptimisticMessage,
    run,
    setElicitationAnswers,
    setPendingElicitation,
    sideQuestions,
  } = transcript
  const directTeammateChatDisabled = conversation?.team_role === 'teammate'
    && !allowTeammateChat
  const hardReadOnly = Boolean(
    conversation?.read_only || conversation?.team_role === 'discriminator',
  )
  const waitingForInput = run?.status === 'waiting_permission'
    || pendingPermission !== null
    || pendingElicitation !== null
  const leaderReviewPending = conversation?.team_role === 'teammate'
    && run?.status === 'waiting_permission'
    && pendingPermission === null
  const sideQuestionAvailable = conversation
    ? canAskSideQuestion(conversation, sessionState.sessionState, active)
    : false
  const commands = availableCommands(
    sessionState.sessionState,
    sideQuestionAvailable ? t('kubecode.btwDescription') : null,
  )
  const openCodeCapabilityEmptyLabel = conversation?.agent_id === 'opencode'
    && sessionState.sessionState?.composer?.catalog
    && !sessionState.sessionState.composer.catalog.items.some((item) => item.kind !== 'command')
    ? t('kubecode.noOpenCodeCapabilities')
    : undefined
  const readiness = agent?.available ? 'ready' : 'missing'
  const canFork = Boolean(
    conversation?.provider_session_id && sessionCapability(sessionState.sessionState, 'fork'),
  )
  const { configs: configSelects, mode: nativeMode } = nativeSessionOptions(
    sessionState.sessionState,
  )

  const composer = useComposerController({
    active,
    agent,
    api,
    appendOptimisticMessage,
    attachRun,
    commands,
    conversation,
    conversationId,
    directTeammateChatDisabled,
    failOptimisticMessage: transcript.failOptimisticMessage,
    hardReadOnly,
    messages,
    onApplyComposerCatalog: sessionState.applyComposerCatalog,
    onClearError: () => setError(null),
    projectId,
    removeOptimisticMessage,
    reportError,
    run,
    sessionState: sessionState.sessionState,
    setSideQuestions: transcript.setSideQuestions,
    t,
    viewRevisionId: history.viewRevisionId,
  })
  const { inputRef, updateComposerDraft, updatePrompt } = composer

  useEffect(() => {
    onPlanChange?.(conversationId ? sessionState.planEntries : [])
  }, [conversationId, onPlanChange, sessionState.planEntries])

  const commandPaletteWritable = Boolean(
    conversation
      && projectId
      && agent?.available
      && !active
      && !directTeammateChatDisabled
      && !hardReadOnly
      && !history.viewRevisionId,
  )
  const commandPaletteCatalog = sessionState.sessionState?.composer?.catalog.conversation_id
    === conversationId
    ? sessionState.sessionState.composer.catalog
    : null
  const commandPaletteCatalogStatus = sessionState.composerCatalogLoadFailed
    ? 'error' as const
    : conversation && !sessionState.sessionState ? 'loading' as const : 'ready' as const
  const executeCommandPaletteItem = useCallback(async (
    selection: RankedCommandPaletteItem,
  ): Promise<boolean> => {
    if (!conversation
      || !projectId
      || !agent?.available
      || active
      || directTeammateChatDisabled
      || hardReadOnly
      || history.viewRevisionId) return false
    const catalog = sessionState.sessionState?.composer?.catalog
    if (!catalog
      || catalog.conversation_id !== conversation.id
      || catalog.revision !== selection.catalogRevision) return false
    const current = catalog.items.find((item) => (
      item.id === selection.id && item.kind === selection.kind && item.enabled
    ))
    if (!current) return false
    try {
      const itemKind = current.kind
      if (itemKind === 'command') {
        const matchingCommands = availableAcpCommands(
          sessionState.sessionState?.available_commands,
        ).filter((command) => command.name === current.name)
        if (matchingCommands.length !== 1
          || matchingCommands[0].ambiguous
          || matchingCommands[0].input.kind === 'unsupported') return false
        if (matchingCommands[0].input.kind === 'text') {
          updatePrompt(`/${current.name} `)
        } else {
          attachRun(await api.dispatchComposerCommand(
            projectId,
            conversation.id,
            current.id,
            catalog.revision,
            '',
          ))
          updatePrompt('')
        }
      } else {
        updateComposerDraft((draft) => appendComposerCapability(
          draft,
          createComposerCapabilityReference({
            catalogRevision: catalog.revision,
            id: current.id,
            itemKind,
            name: current.name,
            scope: current.scope,
            sourceLabel: current.source_label,
          }),
        ))
      }
      window.requestAnimationFrame(() => inputRef.current?.focus())
      trackEvent('kubecode_command_palette_item_selected', {
        agent_id: conversation.agent_id,
        kind: itemKind,
      })
      return true
    } catch (cause) {
      reportError(cause)
      return false
    }
  }, [
    active,
    agent?.available,
    api,
    attachRun,
    conversation,
    directTeammateChatDisabled,
    hardReadOnly,
    history.viewRevisionId,
    inputRef,
    projectId,
    reportError,
    sessionState.sessionState,
    updateComposerDraft,
    updatePrompt,
  ])

  useEffect(() => {
    if (!onCommandPaletteSessionChange) return
    onCommandPaletteSessionChange({
      agentId: conversation?.agent_id ?? null,
      catalog: commandPaletteCatalog,
      catalogStatus: commandPaletteCatalogStatus,
      conversationId,
      execute: executeCommandPaletteItem,
      projectId,
      writable: commandPaletteWritable,
    })
    return () => onCommandPaletteSessionChange(null)
  }, [
    commandPaletteCatalog,
    commandPaletteCatalogStatus,
    commandPaletteWritable,
    conversation?.agent_id,
    conversationId,
    executeCommandPaletteItem,
    onCommandPaletteSessionChange,
    projectId,
  ])

  const stop = async () => {
    if (run) await api.cancelRun(run.id)
  }

  const resolveElicitation = async (accepted: boolean) => {
    if (!pendingElicitation || !conversation) return
    const content = accepted
      ? elicitationContent(pendingElicitation, elicitationAnswers)
      : null
    await api.resolveElicitation(pendingElicitation.requestId, content)
    setPendingElicitation(null)
    trackEvent('kubecode_agent_elicitation_resolved', {
      accepted: accepted ? 1 : 0,
      agent_id: conversation.agent_id,
      field_count: pendingElicitation.properties.length,
    })
  }

  const rename = async () => {
    if (!conversation) return
    const updated = await api.updateConversation(conversation.id, draftTitle.trim() || null)
    onConversationUpdated(updated)
    setRenameOpen(false)
    trackEvent('kubecode_session_renamed', { agent_id: conversation.agent_id })
  }

  const restoreAgentTitle = async () => {
    if (!conversation) return
    onConversationUpdated(await api.updateConversation(conversation.id, null))
  }

  const deleteSession = async () => {
    if (!conversation) return
    try {
      await api.deleteConversation(conversation.id)
      const removedConversationIds = conversation.team_role === 'leader' && team
        ? team.members.map((member) => member.conversation_id)
        : [conversation.id]
      for (const conversationId of removedConversationIds) onConversationRemoved(conversationId)
      setDeleteTeamOpen(false)
      trackEvent('kubecode_session_deleted', {
        agent_id: conversation.agent_id,
        team_size: removedConversationIds.length,
      })
    } catch (cause) {
      reportError(cause)
    }
  }

  const requestDelete = () => {
    if (conversation?.team_role === 'leader'
      || team?.leader_conversation.id === conversation?.id) {
      setDeleteTeamOpen(true)
      return
    }
    void deleteSession()
  }

  const forkSession = async () => {
    if (!conversation) return
    const fork = await api.forkConversation(conversation.id)
    onConversationCreated(fork)
    trackEvent('kubecode_agent_session_forked', { agent_id: conversation.agent_id })
  }

  // Per-turn fork (#100): one action on a completed turn opens a child cut
  // at that boundary; the source conversation is never disturbed.
  const forkFromTurn = async (runId: string) => {
    if (!conversation) return
    try {
      const child = await api.forkFromTurn(conversation.id, runId)
      onConversationCreated(child)
      trackEvent('kubecode_agent_turn_forked', { agent_id: conversation.agent_id })
    } catch (cause) {
      reportError(cause)
    }
  }

  const promoteToTeam = async () => {
    if (!conversation) return
    try {
      const team = await api.promoteToTeam(conversation.id, agentName(conversation.agent_id))
      onTeamCreated?.(team)
      trackEvent('kubecode_session_promoted_to_team', { leader_agent_id: conversation.agent_id })
    } catch (cause) {
      reportError(cause)
    }
  }

  if (!conversation) {
    const readyAgents = agents.filter((candidate) => candidate.available)
    return (
      <section className="kubecode-agent-session kubecode-session-empty" data-testid="agent-session-workspace">
        <img
          alt=""
          aria-hidden="true"
          className="kubecode-session-empty-mark"
          src={`${import.meta.env.BASE_URL}logo.svg`}
        />
        <h1>{projectId ? t('kubecode.startSession') : t('kubecode.firstRunTitle')}</h1>
        <p>{projectId ? t('kubecode.startSessionDescription') : t('kubecode.firstRunDescription')}</p>
        <div className="kubecode-agent-readiness-grid">
          {agents.map((candidate) => (
            <div
              className="kubecode-agent-readiness-card"
              data-ready={candidate.available}
              key={candidate.id}
            >
              <AiAgentIcon agent={candidate.id} size={22} />
              <span>
                <strong>{agentName(candidate.id)}</strong>
                <small>
                  {candidate.available
                    ? candidate.version ?? t('kubecode.ready')
                    : t('kubecode.unavailable')}
                </small>
              </span>
            </div>
          ))}
        </div>
        <div className="kubecode-session-empty-actions">
          {projectId ? (
            <Button
              aria-label={t('kubecode.startSession')}
              disabled={readyAgents.length === 0}
              onClick={onNewSession}
            >
              <Plus  size={16}/>
              {t('kubecode.newSession')}
            </Button>
          ) : (
            <Button aria-label={t('kubecode.firstRunTitle')} onClick={onAddProject}>
              <Plus  size={16}/>
              {t('kubecode.addProject')}
            </Button>
          )}
          <Button
            disabled={agentsRefreshing}
            variant="outline"
            onClick={() => void onRefreshAgents?.()}
          >
            <RotateCw className={agentsRefreshing ? 'animate-spin' : undefined}  size={16}/>
            {t('kubecode.checkAgain')}
          </Button>
          <Button variant="ghost" onClick={onOpenAgentSettings}>
            <Settings  size={16}/>
            {t('kubecode.agentSettings')}
          </Button>
        </div>
        {projectId && readyAgents.length === 0 && (
          <span className="kubecode-session-empty-hint">{t('kubecode.noReadyAgents')}</span>
        )}
      </section>
    )
  }

  const modeLockReason = nativeModeLockReason({
    active,
    agentId: conversation.agent_id,
    conversation,
    serverAccess: sessionState.sessionState?.mode_access,
    team,
    viewRevisionId: history.viewRevisionId,
  })

  const commitSessionOption = async (
    optimisticState: AgentSessionState | null,
    request: () => Promise<void>,
  ) => {
    const confirmedState = sessionState.sessionState
    const restoreConfirmedState = sessionState.beginSessionStateRequest(conversation.id)
    setError(null)
    sessionState.setSessionState(optimisticState)
    try {
      await request()
    } catch (cause) {
      restoreConfirmedState(confirmedState)
      reportError(cause)
      return
    }
    try {
      await sessionState.requestSessionState(conversation.id)
    } catch (cause) {
      reportError(cause)
    }
  }

  const changeAgentConfig = (configId: string, value: string | boolean) => {
    trackEvent('kubecode_agent_setting_selected', {
      agent_id: conversation.agent_id,
      setting: configId,
    })
    void commitSessionOption(
      sessionStateWithConfig(sessionState.sessionState, configId, value),
      () => api.setSessionConfig(conversation.id, configId, value),
    )
  }

  const changeNativeMode = (value: string) => {
    if (!nativeMode || modeLockReason) return
    trackEvent('kubecode_agent_setting_selected', {
      agent_id: conversation.agent_id,
      setting: 'mode',
    })
    if (nativeMode.kind === 'mode') {
      void commitSessionOption(
        sessionStateWithMode(sessionState.sessionState, value),
        () => api.setSessionMode(conversation.id, value),
      )
      return
    }
    void commitSessionOption(
      sessionStateWithConfig(sessionState.sessionState, nativeMode.id, value),
      () => api.setSessionConfig(conversation.id, nativeMode.id, value),
    )
  }

  const titlebar = (
    <SessionTitlebar
      active={active}
      canFork={canFork}
      conversation={conversation}
      leaderReviewPending={leaderReviewPending}
      locale={locale}
      onForkSession={() => void forkSession()}
      onPromoteToTeam={() => void promoteToTeam()}
      onRename={() => {
        setDraftTitle(conversation.manual_title ?? conversation.title)
        setRenameOpen(true)
      }}
      onRequestDelete={requestDelete}
      onRestoreAgentTitle={() => void restoreAgentTitle()}
      onTeamViewChange={setTeamView}
      pendingElicitation={Boolean(pendingElicitation)}
      t={t}
      team={team ?? null}
      teamView={teamView}
      usage={sessionState.sessionState?.usage ?? null}
      waitingForInput={waitingForInput}
    />
  )

  return (
    <section
      className="kubecode-agent-session"
      data-team-view={team ? teamView : 'chat'}
      data-testid="agent-session-workspace"
    >
      {titlebarTarget ? createPortal(titlebar, titlebarTarget) : (
        <header className="kubecode-session-header">{titlebar}</header>
      )}
      {team && conversation && (
        <>
          {teamView === 'chat' && (
            <TeamSessionOverview
              activeConversationId={conversation.id}
              onSelectMember={onSelectTeamMember ?? (() => undefined)}
              snapshot={team}
              t={t}
            />
          )}
          {teamView === 'team' && (
            <TeamWorkspaceView
              api={api}
              onSelectMember={(conversationId) => {
                setTeamView('chat')
                onSelectTeamMember?.(conversationId)
              }}
              onSnapshotChange={onTeamUpdated ?? onTeamCreated ?? (() => undefined)}
              snapshot={team}
              t={t}
            />
          )}
        </>
      )}
      {(!team || teamView === 'chat') && (
        <>
          <SessionTimeline
            agentLabel={agentLabel}
            historyCursor={history.historyCursor}
            isActive={active}
            loadingEarlier={history.loadingEarlier}
            locale={locale}
            messages={messages}
            onEditMessage={history.viewRevisionId || directTeammateChatDisabled || hardReadOnly
              ? undefined
              : (runId, userMessage) => void history.reviseAtRun(runId, userMessage)}
            onForkMessage={history.viewRevisionId || directTeammateChatDisabled
              ? undefined
              : (runId) => void forkFromTurn(runId)}
            forkUnavailableLabel={t('kubecode.forkUnavailableRunning')}
            subagents={transcript.subagents}
            onLoadEarlierHistory={() => void history.loadEarlierHistory()}
            onRegenerateMessage={history.viewRevisionId || directTeammateChatDisabled || hardReadOnly
              ? undefined
              : (runId) => void history.regenerate(runId)}
            onSelectRevision={history.selectRevision}
            recreatedContext={Boolean(conversation.recreated_context)}
            readiness={readiness}
            revisions={history.revisions}
            t={t}
            viewRevisionId={history.viewRevisionId}
          />
          <PromptQueueDock
            items={transcript.promptQueue}
            onEdit={(itemId, content) => {
              void api.editPromptQueueItem(conversation.id, itemId, content)
                .catch(reportError)
            }}
            onRemove={(itemId) => {
              void api.removePromptQueueItem(conversation.id, itemId)
                .catch(reportError)
            }}
            onSendNow={(itemId) => {
              void api.sendPromptQueueNow(conversation.id, itemId)
                .catch(reportError)
            }}
            t={t}
          />
          <SessionComposer
            agentLabel={agentLabel}
            api={api}
            changeNativeMode={changeNativeMode}
            commands={commands}
            composer={composer}
            configSelects={configSelects}
            conversation={conversation}
            directTeammateChatDisabled={directTeammateChatDisabled}
            elicitationAnswers={elicitationAnswers}
            error={error}
            hardReadOnly={hardReadOnly}
            isActive={active}
            leaderReviewPending={leaderReviewPending}
            locale={locale}
            modeLockReason={modeLockReason}
            nativeMode={nativeMode}
            onDismissError={() => setError(null)}
            onDismissWorkspaceWarning={() => setWorkspaceWarning(null)}
            onChangeAgentConfig={changeAgentConfig}
            onElicitationAnswerChange={(id, value) => setElicitationAnswers((current) => ({
              ...current,
              [id]: value,
            }))}
            onOpenPlan={onOpenPlan}
            onResolveElicitation={(accepted) => void resolveElicitation(accepted)}
            onResolvePermission={(requestId, optionId) => void api.resolvePermission(requestId, optionId)}
            onSend={(text) => void composer.send(text)}
            onSendSideQuestion={(text) => void composer.sendSideQuestion(text)}
            onStop={() => void stop()}
            onUndoTurn={() => {
              if (run) void history.reviseAtRun(run.id)
            }}
            openCodeCapabilityEmptyLabel={openCodeCapabilityEmptyLabel}
            pendingElicitation={pendingElicitation}
            pendingPermission={pendingPermission}
            deadlineMs={pendingPermission
              && transcript.pendingWait?.requestId === pendingPermission.requestId
              ? transcript.pendingWait.deadlineMs
              : null}
            planEntries={sessionState.planEntries}
            projectId={projectId}
            readiness={readiness}
            reportError={reportError}
            run={run}
            session={sessionState}
            sideQuestionAvailable={sideQuestionAvailable}
            sideQuestions={sideQuestions}
            t={t}
            terminalContextSources={terminalContextSources}
            viewRevisionId={history.viewRevisionId}
            workspaceWarning={workspaceWarning}
          />
        </>
      )}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.renameSession')}</DialogTitle>
            <DialogDescription>{t('kubecode.renameSessionDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t('kubecode.sessionTitle')}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
            }}
          />
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">{t('kubecode.cancel')}</Button></DialogClose>
            <Button onClick={() => void rename()}>{t('kubecode.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteTeamDialog
        onConfirm={deleteSession}
        onOpenChange={setDeleteTeamOpen}
        open={deleteTeamOpen}
        t={t}
        teamName={team?.team.title.trim() || conversation.title || t('kubecode.teamSession')}
        teammateCount={team
          ? team.members.filter((member) => member.role === 'teammate').length
          : 0}
      />
    </section>
  )
}
