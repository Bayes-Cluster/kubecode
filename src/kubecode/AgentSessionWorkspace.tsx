import { useCallback, useEffect, useRef, useState } from 'react'
import { CaretDown, Check, DotsThree, LockKey, ShieldWarning } from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { AiPanelComposer, AiPanelMessageHistory } from '@/components/AiPanelChrome'
import type { AiAction } from '@/components/AiMessage'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { AppLocale, TranslationKey } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import {
  ApiError,
  type AgentDescriptor,
  type AgentEvent,
  type AgentRun,
  type AgentSessionState,
  type Conversation,
  type KubecodeApi,
  type SessionEvent,
  type TeamSnapshot,
  type WorkspaceEvent,
} from './api'
import { SystemMessageNotice } from './SystemMessageNotice'
import { ComposerAddMenu } from './ComposerAddMenu'
import { AgentConfigMenu, type AgentConfigGroup } from './AgentConfigMenu'
import { useSystemMessages } from './systemMessages'
import { TeamSessionOverview } from './TeamSessionOverview'

type Translator = (key: TranslationKey) => string
type PermissionChoice = { id: string; label: string; kind: string }
type PendingPermission = { requestId: string; tool: string; options: PermissionChoice[] }
type ElicitationAnswer = string | boolean
type ElicitationOption = { id: string; name: string }
type ElicitationProperty = {
  defaultValue: ElicitationAnswer
  description: string
  id: string
  label: string
  options: ElicitationOption[]
  required: boolean
  type: 'boolean' | 'integer' | 'number' | 'string'
}
type PendingElicitation = {
  message: string
  properties: ElicitationProperty[]
  requestId: string
}
type SessionPlanEntry = {
  content: string
  priority: string
  status: 'completed' | 'in_progress' | 'pending'
}

type AgentSessionWorkspaceProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  conversation: Conversation | null
  locale: AppLocale
  onConversationCreated: (conversation: Conversation) => void
  onConversationRemoved: (conversationId: string) => void
  onConversationUpdated: (conversation: Conversation) => void
  onTeamCreated?: (team: TeamSnapshot) => void
  onSelectTeamMember?: (conversationId: string) => void
  projectId: string | null
  t: Translator
  workspaceEvents: WorkspaceEvent[]
  team?: TeamSnapshot | null
}

const ACTIVE_RUN_STATUSES = new Set<AgentRun['status']>(['running', 'waiting_permission'])
const SESSION_STATE_EVENT_KINDS = new Set([
  'available_commands',
  'config_options',
  'current_mode',
  'plan',
  'run_completed',
  'session_info',
  'usage',
])
const SESSION_TIMELINE_EVENT_KINDS = new Set([
  'error',
  'run_completed',
  'text_delta',
  'thinking_delta',
  'tool_completed',
  'tool_started',
  'tool_updated',
  'user_message',
  'user_message_delta',
])
export function AgentSessionWorkspace({
  agents,
  api,
  conversation,
  locale,
  onConversationCreated,
  onConversationRemoved,
  onConversationUpdated,
  onTeamCreated,
  onSelectTeamMember,
  projectId,
  t,
  workspaceEvents,
  team,
}: AgentSessionWorkspaceProps) {
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<AiAgentMessage[]>([])
  const [run, setRun] = useState<AgentRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [pendingElicitation, setPendingElicitation] = useState<PendingElicitation | null>(null)
  const [elicitationAnswers, setElicitationAnswers] = useState<Record<string, ElicitationAnswer>>({})
  const [sessionState, setSessionState] = useState<AgentSessionState | null>(null)
  const [planOpen, setPlanOpen] = useState(true)
  const [renameOpen, setRenameOpen] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const systemMessages = useSystemMessages()
  const inputRef = useRef<HTMLDivElement>(null)
  const knownRunIdsRef = useRef(new Set<string>())
  const loadingRunsRef = useRef(new Map<string, Promise<AgentRun>>())
  const pendingRunEventsRef = useRef(new Map<string, AgentEvent[]>())
  const processedWorkspaceEventRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  const latestWorkspaceEventIdRef = useRef(workspaceEvents.at(-1)?.id ?? 0)
  latestWorkspaceEventIdRef.current = workspaceEvents.at(-1)?.id ?? 0
  const agent = agents.find((item) => item.id === conversation?.agent_id)
  const agentLabel = conversation ? agentName(conversation.agent_id) : t('kubecode.agent')
  const active = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))
  const waitingForInput = run?.status === 'waiting_permission'
    || pendingPermission !== null
    || pendingElicitation !== null
  const reportError = useCallback((cause: unknown) => {
    const message = errorMessage(cause, t('kubecode.error'))
    if (systemMessages) {
      systemMessages.publish({ level: 'error', message, source: agentLabel })
    } else {
      setError(message)
    }
  }, [agentLabel, systemMessages, t])

  const attachRun = useCallback((nextRun: AgentRun) => {
    knownRunIdsRef.current.add(nextRun.id)
    const pending = pendingRunEventsRef.current.get(nextRun.id) ?? []
    pendingRunEventsRef.current.delete(nextRun.id)
    setMessages((current) => {
      const initial = current.some((message) => message.id === nextRun.id)
        ? current
        : [...current, messageFromRun(nextRun)]
      return pending.reduce(
        (history, event) => applyAgentEvent(history, nextRun.id, event),
        initial,
      )
    })
    setRun((current) => (
      current?.id === nextRun.id
        && !ACTIVE_RUN_STATUSES.has(current.status)
        && ACTIVE_RUN_STATUSES.has(nextRun.status)
        ? current
        : nextRun
    ))
  }, [])

  const loadRun = useCallback((runId: string) => {
    const loading = loadingRunsRef.current.get(runId)
    if (loading) return loading
    const request = api.getRun(runId)
    loadingRunsRef.current.set(runId, request)
    void request.then(attachRun).finally(() => loadingRunsRef.current.delete(runId))
    return request
  }, [api, attachRun])

  useEffect(() => {
    if (!conversation) return
    knownRunIdsRef.current.clear()
    loadingRunsRef.current.clear()
    pendingRunEventsRef.current.clear()
    processedWorkspaceEventRef.current = latestWorkspaceEventIdRef.current
    let current = true
    void hydrateConversation(api, conversation.id).then(({ messages: history, activeRun, pendingPermission: restoredPermission, pendingElicitation: restoredElicitation, sessionState: restoredState }) => {
      if (!current) return
      setMessages(history)
      knownRunIdsRef.current = new Set(history.flatMap((message) => message.id ? [message.id] : []))
      setRun(activeRun)
      setPendingPermission(restoredPermission)
      setPendingElicitation(restoredElicitation)
      setElicitationAnswers(initialElicitationAnswers(restoredElicitation))
      setSessionState(restoredState)
    }).catch((cause: unknown) => {
      if (current) reportError(cause)
    })
    return () => { current = false }
  }, [api, conversation, reportError])

  useEffect(() => {
    if (!conversation) return
    const nextEvents = workspaceEvents.filter((event) => (
      event.id > processedWorkspaceEventRef.current
        && event.conversation_id === conversation.id
        && event.run_id
    ))
    processedWorkspaceEventRef.current = workspaceEvents.at(-1)?.id
      ?? processedWorkspaceEventRef.current
    let refreshState = false
    for (const workspaceEvent of nextEvents) {
      const event: AgentEvent = {
        created_at: workspaceEvent.created_at,
        kind: workspaceEvent.kind,
        payload: workspaceEvent.payload,
        run_id: workspaceEvent.run_id as string,
        seq: workspaceEvent.id,
      }
      if (event.kind === 'permission_requested') {
        const permission = permissionFromEvent(event)
        if (permission) setPendingPermission(permission)
      }
      if (event.kind === 'permission_resolved') setPendingPermission(null)
      if (event.kind === 'elicitation_requested') {
        const elicitation = elicitationFromEvent(event)
        if (elicitation) {
          setPendingElicitation(elicitation)
          setElicitationAnswers(initialElicitationAnswers(elicitation))
        }
      }
      if (event.kind === 'elicitation_resolved') setPendingElicitation(null)
      if (event.kind === 'run_started') {
        void loadRun(event.run_id)
      } else if (knownRunIdsRef.current.has(event.run_id)) {
        setMessages((current) => applyAgentEvent(current, event.run_id, event))
      } else {
        const pending = pendingRunEventsRef.current.get(event.run_id) ?? []
        pendingRunEventsRef.current.set(event.run_id, [...pending, event])
        void loadRun(event.run_id)
      }
      if (event.kind === 'run_completed') {
        void api.getRun(event.run_id).then(attachRun)
      }
      refreshState ||= SESSION_STATE_EVENT_KINDS.has(event.kind)
    }
    if (refreshState) void api.getSessionState(conversation.id).then(setSessionState)
  }, [api, attachRun, conversation, loadRun, workspaceEvents])

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || !conversation || !projectId || !agent?.available || active) return
    setError(null)
    try {
      const nextRun = await api.startRun(
        projectId,
        conversation.id,
        message,
      )
      attachRun(nextRun)
      setPrompt('')
      trackEvent('kubecode_agent_run_started', {
        agent_id: conversation.agent_id,
      })
    } catch (cause) {
      reportError(cause)
    }
  }

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

  const removeLocally = async () => {
    if (!conversation) return
    await api.removeConversation(conversation.id)
    onConversationRemoved(conversation.id)
    trackEvent('kubecode_session_removed', { agent_id: conversation.agent_id, scope: 'local' })
  }

  const forkSession = async () => {
    if (!conversation) return
    const fork = await api.forkConversation(conversation.id)
    onConversationCreated(fork)
    trackEvent('kubecode_agent_session_forked', { agent_id: conversation.agent_id })
  }

  const branchAtRun = async (runId: string, replacement?: string) => {
    if (!conversation || !projectId || active) return
    try {
      let branch: Conversation
      try {
        branch = await api.branchConversationAtRun(conversation.id, runId, true)
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.code !== 'checkpoint_unavailable') throw cause
        branch = await api.branchConversationAtRun(conversation.id, runId, false)
        const message = t('kubecode.branchFilesNotRestored')
        if (systemMessages) systemMessages.publish({ level: 'warning', message, source: agentLabel })
        else setError(message)
      }
      onConversationCreated(branch)
      if (replacement?.trim()) {
        await api.startRun(projectId, branch.id, replacement.trim())
      }
      trackEvent('kubecode_agent_chat_branched', {
        action: replacement ? 'regenerate' : 'undo',
        agent_id: conversation.agent_id,
      })
    } catch (cause) {
      reportError(cause)
    }
  }

  const regenerate = async (runId: string) => {
    const message = messages.find((candidate) => candidate.id === runId)?.userMessage
    if (message) await branchAtRun(runId, message)
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
    return (
      <section className="kubecode-agent-session kubecode-session-empty" data-testid="agent-session-workspace">
        <div className="kubecode-session-empty-mark">K</div>
        <h1>{t('kubecode.startSession')}</h1>
        <p>{projectId ? t('kubecode.startSessionDescription') : t('kubecode.selectProject')}</p>
        {projectId && <span className="kubecode-session-empty-hint">{t('kubecode.newSessionDescription')}</span>}
      </section>
    )
  }

  const readiness = agent?.available ? 'ready' : 'missing'
  const commands = availableCommands(sessionState)
  const canFork = Boolean(
    conversation.provider_session_id && sessionCapability(sessionState, 'fork'),
  )
  const visibleCommands = prompt.startsWith('/')
    ? commands.filter((command) => command.name.toLowerCase().includes(prompt.slice(1).toLowerCase()))
    : []
  const nativeMode = sessionMode(sessionState)
  const configSelects = distinctSessionConfigSelects(nativeMode, sessionConfigSelects(sessionState))
  const agentConfigGroups = buildAgentConfigGroups(nativeMode, configSelects, t)
  const planEntries = sessionPlanEntries(sessionState?.plan)
  const completedPlanEntries = planEntries.filter((entry) => entry.status === 'completed').length

  const insertComposerText = (text: string, kind: 'command' | 'file') => {
    setPrompt((current) => {
      if (!current) return text
      return `${current}${current.endsWith(' ') ? '' : ' '}${text}`
    })
    window.requestAnimationFrame(() => inputRef.current?.focus())
    trackEvent('kubecode_agent_context_inserted', {
      agent_id: conversation.agent_id,
      kind,
    })
  }

  const refreshSessionState = async () => {
    setSessionState(await api.getSessionState(conversation.id))
  }

  const commitSessionOption = async (
    optimisticState: AgentSessionState | null,
    request: () => Promise<void>,
  ) => {
    const confirmedState = sessionState
    setError(null)
    setSessionState(optimisticState)
    try {
      await request()
    } catch (cause) {
      setSessionState(confirmedState)
      reportError(cause)
      return
    }
    try {
      await refreshSessionState()
    } catch (cause) {
      reportError(cause)
    }
  }

  const changeAgentConfig = (groupId: string, value: string) => {
    trackEvent('kubecode_agent_setting_selected', {
      agent_id: conversation.agent_id,
      setting: groupId === 'mode:agent' ? 'mode' : groupId.slice('config:'.length),
    })
    if (groupId === 'mode:agent') {
      void commitSessionOption(
        sessionStateWithMode(sessionState, value),
        () => api.setSessionMode(conversation.id, value),
      )
      return
    }
    const configId = groupId.slice('config:'.length)
    void commitSessionOption(
      sessionStateWithConfig(sessionState, configId, value),
      () => api.setSessionConfig(conversation.id, configId, value),
    )
  }

  return (
    <section className="kubecode-agent-session" data-testid="agent-session-workspace">
      <header className="kubecode-session-header">
        <div className="kubecode-session-title">
          <AiAgentIcon agent={conversation.agent_id} size={20} />
          <strong>{conversation.title || t('kubecode.untitledSession')}</strong>
        </div>
        <div className="kubecode-session-status">
          <span data-state={waitingForInput ? 'stuck' : active ? 'running' : 'idle'} />
          {waitingForInput
            ? t(pendingElicitation ? 'kubecode.answerAgentQuestion' : 'kubecode.permissionRequired')
            : active ? t('kubecode.running') : t('kubecode.ready')}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label={t('kubecode.sessionActions')} size="icon-xs" variant="ghost">
                <DotsThree />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => {
                setDraftTitle(conversation.manual_title ?? conversation.title)
                setRenameOpen(true)
              }}>
                {t('kubecode.renameSession')}
              </DropdownMenuItem>
              {conversation.manual_title && conversation.agent_title && (
                <DropdownMenuItem onSelect={() => void restoreAgentTitle()}>
                  {t('kubecode.useAgentTitle')}
                </DropdownMenuItem>
              )}
              {canFork && (
                <DropdownMenuItem onSelect={() => void forkSession()}>
                  {t('kubecode.forkSession')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void promoteToTeam()}>
                {t('kubecode.promoteToTeam')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void removeLocally()}>
                {t('kubecode.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {team && conversation && (
        <TeamSessionOverview
          activeConversationId={conversation.id}
          onSelectMember={onSelectTeamMember ?? (() => undefined)}
          snapshot={team}
        />
      )}
      <div className="kubecode-session-timeline">
        <AiPanelMessageHistory
          agentLabel={agentLabel}
          agentReadiness={readiness}
          hasContext
          isActive={active}
          leadingContent={conversation.recreated_context ? (
            <div className="kubecode-recreated-context">{t('kubecode.recreatedContext')}</div>
          ) : undefined}
          locale={locale}
          messages={messages}
          onEditMessage={(runId, userMessage) => void branchAtRun(runId, userMessage)}
          onRegenerateMessage={(runId) => void regenerate(runId)}
        />
      </div>
      {error && (
        <SystemMessageNotice
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}
      {pendingPermission && (
        <div aria-live="polite" className="kubecode-permission-dock">
          <div className="kubecode-permission-heading">
            <ShieldWarning size={17} />
            <strong>{t('kubecode.permissionRequired')}</strong>
          </div>
          <code className="kubecode-permission-command">{pendingPermission.tool}</code>
          <div className="kubecode-permission-actions">
            {pendingPermission.options.map((option) => (
              <Button
                key={option.id}
                size="sm"
                title={option.label}
                variant={option.kind.startsWith('reject') ? 'outline' : 'default'}
                onClick={() => void api.resolvePermission(pendingPermission.requestId, option.id)}
              >
                {permissionChoiceLabel(option, t)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {pendingElicitation && (
        <div className="kubecode-elicitation-dock">
          <div className="kubecode-elicitation-heading">
            <strong>{t('kubecode.answerAgentQuestion')}</strong>
            <span>{pendingElicitation.message}</span>
          </div>
          <div className="kubecode-elicitation-fields">
            {pendingElicitation.properties.map((property) => (
              <label key={property.id} className="kubecode-elicitation-field">
                <span>{property.label}{property.required ? ' *' : ''}</span>
                {property.description && <small>{property.description}</small>}
                {property.type === 'boolean' ? (
                  <Switch
                    aria-label={property.label}
                    checked={Boolean(elicitationAnswers[property.id])}
                    onCheckedChange={(value) => setElicitationAnswers((current) => ({
                      ...current,
                      [property.id]: value,
                    }))}
                  />
                ) : property.options.length > 0 ? (
                  <Select
                    value={String(elicitationAnswers[property.id] ?? '')}
                    onValueChange={(value) => setElicitationAnswers((current) => ({
                      ...current,
                      [property.id]: value,
                    }))}
                  >
                    <SelectTrigger aria-label={property.label}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {property.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={property.label}
                    type={property.type === 'string' ? 'text' : 'number'}
                    value={String(elicitationAnswers[property.id] ?? '')}
                    onChange={(event) => setElicitationAnswers((current) => ({
                      ...current,
                      [property.id]: event.target.value,
                    }))}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="kubecode-elicitation-actions">
            <Button size="sm" variant="outline" onClick={() => void resolveElicitation(false)}>
              {t('kubecode.decline')}
            </Button>
            <Button
              disabled={!elicitationComplete(pendingElicitation, elicitationAnswers)}
              size="sm"
              onClick={() => void resolveElicitation(true)}
            >
              {t('kubecode.submitAnswers')}
            </Button>
          </div>
        </div>
      )}
      {planEntries.length > 0 && (
        <div className="kubecode-session-plan">
          <Button
            aria-expanded={planOpen}
            className="kubecode-session-plan-trigger"
            size="sm"
            variant="ghost"
            onClick={() => setPlanOpen((open) => !open)}
          >
            <span>{completedPlanEntries} / {planEntries.length}</span>
            <span>{planOpen ? t('kubecode.hideAgentPlan') : t('kubecode.showAgentPlan')}</span>
            <CaretDown data-open={planOpen} />
          </Button>
          {planOpen && (
            <ol className="kubecode-session-plan-list">
              {planEntries.map((entry, index) => (
                <li
                  className="kubecode-session-plan-entry"
                  data-priority={entry.priority}
                  data-status={entry.status}
                  key={`${index}-${entry.content}`}
                >
                  <span className="kubecode-session-plan-state" aria-hidden="true">
                    {entry.status === 'completed' && <Check weight="bold" />}
                  </span>
                  <span>{entry.content}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="kubecode-session-composer">
        {conversation.read_only ? (
          <div className="kubecode-read-only-session">
            <LockKey />
            <span>{t('kubecode.readOnlySubagent')}</span>
          </div>
        ) : (
          <>
            {run && ['cancelled', 'failed', 'interrupted'].includes(run.status) && (
              <Button className="kubecode-undo-turn" size="sm" variant="ghost" onClick={() => void branchAtRun(run.id)}>
                {t('kubecode.undoTurn')}
              </Button>
            )}
            {visibleCommands.length > 0 && (
              <div className="kubecode-command-suggestions">
                {visibleCommands.map((command) => (
                  <Button key={command.name} variant="ghost" onClick={() => setPrompt(`/${command.name} `)}>
                    <code>/{command.name}</code>
                    {command.description && <span>{command.description}</span>}
                  </Button>
                ))}
              </div>
            )}
            <AiPanelComposer
              agentLabel={agentLabel}
              agentReadiness={readiness}
              leadingControl={projectId ? (
                <ComposerAddMenu
                  api={api}
                  commands={commands}
                  onInsert={insertComposerText}
                  projectId={projectId}
                  t={t}
                />
              ) : undefined}
              controls={agentConfigGroups.length > 0 ? (
                <AgentConfigMenu
                  groups={agentConfigGroups}
                  onChange={changeAgentConfig}
                  t={t}
                />
              ) : undefined}
              entries={[]}
              input={prompt}
              inputRef={inputRef}
              isActive={active}
              locale={locale}
              onChange={setPrompt}
              onSend={(text) => void send(text)}
              onStop={() => void stop()}
            />
          </>
        )}
      </div>
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
    </section>
  )
}

async function hydrateConversation(
  api: KubecodeApi,
  conversationId: string,
): Promise<{
  messages: AiAgentMessage[]
  activeRun: AgentRun | null
  pendingPermission: PendingPermission | null
  pendingElicitation: PendingElicitation | null
  sessionState: AgentSessionState
}> {
  const [runs, sessionEvents, sessionState] = await Promise.all([
    api.listRuns(conversationId),
    api.listSessionEvents(conversationId),
    api.getSessionState(conversationId),
  ])
  const events = await Promise.all(runs.map((run) => api.listEvents(run.id)))
  const messages = sessionEvents.length > 0
    ? messagesFromSessionEvents(sessionEvents, runs)
    : runs.map((run, index) => (
        events[index].reduce(
          (history, event) => applyAgentEvent(history, run.id, event),
          [messageFromRun(run)],
        )[0]
      ))
  const activeRun = [...runs].reverse().find((item) => ACTIVE_RUN_STATUSES.has(item.status)) ?? null
  const activeRunIndex = activeRun ? runs.findIndex((item) => item.id === activeRun.id) : -1
  const pendingPermission = activeRunIndex >= 0
    ? pendingPermissionFromEvents(events[activeRunIndex])
    : null
  const pendingElicitation = activeRunIndex >= 0
    ? pendingElicitationFromEvents(events[activeRunIndex])
    : null
  return { messages, activeRun: runs.at(-1) ?? null, pendingPermission, pendingElicitation, sessionState }
}

function messagesFromSessionEvents(events: SessionEvent[], runs: AgentRun[]): AiAgentMessage[] {
  const runById = new Map(runs.map((run) => [run.id, run]))
  return events.reduce<AiAgentMessage[]>((messages, event) => {
    if (!SESSION_TIMELINE_EVENT_KINDS.has(event.kind)) return messages
    const runId = textValue(event.payload.run_id)
    if (event.kind === 'user_message') {
      const run = runById.get(runId)
      return [...messages, run ? messageFromRun(run) : nativeMessage(event, textValue(event.payload.text))]
    }
    if (event.kind === 'user_message_delta') {
      const last = messages.at(-1)
      const text = textValue(event.payload.text)
      if (last?.id?.startsWith('native-') && !last.response && !last.reasoning) {
        return [...messages.slice(0, -1), { ...last, userMessage: `${last.userMessage ?? ''}${text}` }]
      }
      return [...messages, nativeMessage(event, text)]
    }
    if (event.kind === 'run_completed' && messages.length === 0) return messages
    const message = messages.at(-1) ?? nativeMessage(event, '')
    const messageId = message.id ?? `native-${event.seq}`
    const history = messages.length > 0 ? messages : [message]
    const mapped: AgentEvent = {
      created_at: event.created_at,
      kind: event.kind,
      payload: event.payload,
      run_id: messageId,
      seq: event.seq,
    }
    return applyAgentEvent(history, messageId, mapped)
  }, [])
}

function permissionChoiceLabel(option: PermissionChoice, t: Translator): string {
  if (option.kind === 'allow_always') return t('kubecode.allowAll')
  if (option.kind === 'allow_once') return t('kubecode.allow')
  if (option.kind === 'reject_once' || option.kind === 'reject_always') {
    return t('kubecode.reject')
  }
  return option.label
}

function nativeMessage(event: SessionEvent, text: string): AiAgentMessage {
  return {
    actions: [],
    id: `native-${event.seq}`,
    isStreaming: false,
    reasoningDone: true,
    userMessage: text,
  }
}

type AgentCommand = { name: string; description: string }

function availableCommands(state: AgentSessionState | null): AgentCommand[] {
  const values = state?.available_commands?.availableCommands
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const command = value as Record<string, unknown>
    const name = textValue(command.name)
    if (!name) return []
    return [{ name, description: textValue(command.description) }]
  })
}

function sessionCapability(state: AgentSessionState | null, capability: string): boolean {
  const sessionCapabilities = state?.capabilities?.sessionCapabilities
  if (!sessionCapabilities || typeof sessionCapabilities !== 'object') return false
  return (sessionCapabilities as Record<string, unknown>)[capability] != null
}

type SessionSelect = {
  id: string
  name: string
  currentValue: string
  options: { id: string; name: string }[]
}

function agentConfigPriority(group: AgentConfigGroup): number {
  const identity = `${group.id} ${group.name}`.toLocaleLowerCase()
  if (/intelligence|reason|effort/.test(identity)) return 0
  if (/\bmode\b/.test(identity)) return 1
  if (/model/.test(identity)) return 2
  if (/fast/.test(identity)) return 3
  return 4
}

function buildAgentConfigGroups(
  mode: SessionSelect | null,
  configs: SessionSelect[],
  t: Translator,
): AgentConfigGroup[] {
  const groups: AgentConfigGroup[] = configs.map((config) => ({
    ...config,
    id: `config:${config.id}`,
  }))
  if (mode) {
    groups.push({
      ...mode,
      id: 'mode:agent',
      name: t('kubecode.agentMode'),
    })
  }
  return groups.sort((left, right) => agentConfigPriority(left) - agentConfigPriority(right))
}

function sessionMode(state: AgentSessionState | null): SessionSelect | null {
  const mode = state?.current_mode
  const currentValue = textValue(mode?.currentModeId)
  const values = mode?.availableModes
  if (!currentValue || !Array.isArray(values)) return null
  const options = selectOptions(values)
  return options.length > 0 ? { id: 'mode', name: 'Mode', currentValue, options } : null
}

function sessionConfigSelects(state: AgentSessionState | null): SessionSelect[] {
  const values = state?.config_options?.configOptions
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const config = value as Record<string, unknown>
    if (config.type !== 'select') return []
    const id = textValue(config.id)
    const name = textValue(config.name)
    const currentValue = textValue(config.currentValue)
    const options = Array.isArray(config.options) ? selectOptions(config.options) : []
    if (!id || !name || !currentValue || options.length === 0) return []
    return [{ id, name, currentValue, options }]
  })
}

function sessionStateWithMode(
  state: AgentSessionState | null,
  currentModeId: string,
): AgentSessionState | null {
  if (!state?.current_mode) return state
  return {
    ...state,
    current_mode: { ...state.current_mode, currentModeId },
  }
}

function sessionStateWithConfig(
  state: AgentSessionState | null,
  configId: string,
  currentValue: string,
): AgentSessionState | null {
  const configOptions = state?.config_options?.configOptions
  if (!state?.config_options || !Array.isArray(configOptions)) return state
  return {
    ...state,
    config_options: {
      ...state.config_options,
      configOptions: configOptions.map((value) => {
        const config = objectValue(value)
        return textValue(config?.id) === configId ? { ...config, currentValue } : value
      }),
    },
  }
}

function sessionPlanEntries(plan: Record<string, unknown> | null | undefined): SessionPlanEntry[] {
  if (!plan) return []
  const nestedPlan = objectValue(plan.plan)
  const values = arrayValue(plan.entries)
    ?? arrayValue(nestedPlan?.entries)
    ?? arrayValue(objectValue(plan.items)?.entries)
  if (!values) return []
  return values.flatMap((value) => {
    const entry = objectValue(value)
    const content = textValue(entry?.content)
    if (!content) return []
    return [{
      content,
      priority: textValue(entry?.priority) || 'medium',
      status: planEntryStatus(textValue(entry?.status)),
    }]
  })
}

function planEntryStatus(status: string): SessionPlanEntry['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress' || status === 'inProgress') return 'in_progress'
  return 'pending'
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function distinctSessionConfigSelects(
  nativeMode: SessionSelect | null,
  configs: SessionSelect[],
): SessionSelect[] {
  const nativeSignature = nativeMode ? sessionSelectSignature(nativeMode) : null
  const ids = new Set<string>()
  return configs.filter((config) => {
    if (ids.has(config.id) || sessionSelectSignature(config) === nativeSignature) return false
    ids.add(config.id)
    return true
  })
}

function sessionSelectSignature(select: SessionSelect): string {
  return select.options
    .map((option) => `${option.id.trim().toLowerCase()}\u0000${option.name.trim().toLowerCase()}`)
    .sort()
    .join('\u0001')
}

function selectOptions(values: unknown[]): { id: string; name: string }[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const option = value as Record<string, unknown>
    const id = textValue(option.id) || textValue(option.value)
    const name = textValue(option.name)
    return id && name ? [{ id, name }] : []
  })
}

function pendingPermissionFromEvents(events: AgentEvent[]): PendingPermission | null {
  return events.reduce<PendingPermission | null>((pending, event) => {
    if (event.kind === 'permission_requested') return permissionFromEvent(event) ?? pending
    if (event.kind !== 'permission_resolved') return pending
    const requestId = textValue(event.payload.request_id)
    return !requestId || pending?.requestId === requestId ? null : pending
  }, null)
}

function pendingElicitationFromEvents(events: AgentEvent[]): PendingElicitation | null {
  return events.reduce<PendingElicitation | null>((pending, event) => {
    if (event.kind === 'elicitation_requested') return elicitationFromEvent(event) ?? pending
    if (event.kind !== 'elicitation_resolved') return pending
    const requestId = textValue(event.payload.request_id)
    return !requestId || pending?.requestId === requestId ? null : pending
  }, null)
}

function elicitationFromEvent(event: AgentEvent): PendingElicitation | null {
  const requestId = textValue(event.payload.request_id)
  const message = textValue(event.payload.message)
  const schema = objectValue(event.payload.requestedSchema)
  const values = objectValue(schema?.properties)
  if (!requestId || !message || !values) return null
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter(isString) : [])
  const properties = Object.entries(values).flatMap(([id, value]) => {
    const property = objectValue(value)
    const type = propertyType(property?.type)
    if (!property || !type) return []
    return [{
      defaultValue: propertyDefault(property, type),
      description: textValue(property.description),
      id,
      label: textValue(property.title) || id,
      options: propertyOptions(property),
      required: required.has(id),
      type,
    }]
  })
  return { message, properties, requestId }
}

function initialElicitationAnswers(elicitation: PendingElicitation | null): Record<string, ElicitationAnswer> {
  return Object.fromEntries(elicitation?.properties.map((property) => [property.id, property.defaultValue]) ?? [])
}

function elicitationComplete(
  elicitation: PendingElicitation,
  answers: Record<string, ElicitationAnswer>,
): boolean {
  return elicitation.properties.every((property) => (
    !property.required || property.type === 'boolean' || String(answers[property.id] ?? '').trim().length > 0
  ))
}

function elicitationContent(
  elicitation: PendingElicitation,
  answers: Record<string, ElicitationAnswer>,
): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const property of elicitation.properties) {
    const value = answers[property.id] ?? property.defaultValue
    if (!property.required && property.type !== 'boolean' && String(value).trim() === '') continue
    if (property.type === 'integer') content[property.id] = Number.parseInt(String(value), 10)
    else if (property.type === 'number') content[property.id] = Number.parseFloat(String(value))
    else content[property.id] = value
  }
  return content
}

function propertyType(value: unknown): ElicitationProperty['type'] | null {
  return value === 'boolean' || value === 'integer' || value === 'number' || value === 'string'
    ? value
    : null
}

function propertyDefault(
  property: Record<string, unknown>,
  type: ElicitationProperty['type'],
): ElicitationAnswer {
  if (type === 'boolean') return typeof property.default === 'boolean' ? property.default : false
  if (typeof property.default === 'string' || typeof property.default === 'number') {
    return String(property.default)
  }
  return propertyOptions(property)[0]?.id ?? ''
}

function propertyOptions(property: Record<string, unknown>): ElicitationOption[] {
  if (Array.isArray(property.oneOf)) {
    return property.oneOf.flatMap((value) => {
      const option = objectValue(value)
      const id = textValue(option?.const)
      if (!id) return []
      return [{ id, name: textValue(option?.title) || id }]
    })
  }
  return Array.isArray(property.enum)
    ? property.enum.filter(isString).map((id) => ({ id, name: id }))
    : []
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function messageFromRun(run: AgentRun): AiAgentMessage {
  return {
    actions: [],
    id: run.id,
    isStreaming: ACTIVE_RUN_STATUSES.has(run.status),
    reasoningDone: !ACTIVE_RUN_STATUSES.has(run.status),
    userMessage: run.message,
  }
}

function applyAgentEvent(
  messages: AiAgentMessage[],
  runId: string,
  event: AgentEvent,
): AiAgentMessage[] {
  return messages.map((message) => {
    if (message.id !== runId) return message
    if (event.kind === 'text_delta') {
      return { ...message, response: `${message.response ?? ''}${textValue(event.payload.text)}` }
    }
    if (event.kind === 'thinking_delta') {
      return { ...message, reasoning: `${message.reasoning ?? ''}${textValue(event.payload.text)}` }
    }
    if (event.kind === 'tool_started' || event.kind === 'tool_updated') {
      return { ...message, actions: upsertAction(message.actions, event, 'pending') }
    }
    if (event.kind === 'tool_completed') {
      return { ...message, actions: upsertAction(message.actions, event, 'done') }
    }
    if (event.kind === 'error') {
      return {
        ...message,
        isStreaming: false,
        reasoningDone: true,
        response: `${message.response ?? ''}${textValue(event.payload.message)}`,
      }
    }
    if (event.kind === 'run_completed') {
      return { ...message, isStreaming: false, reasoningDone: true }
    }
    return message
  })
}

function upsertAction(
  actions: AiAction[],
  event: AgentEvent,
  status: AiAction['status'],
): AiAction[] {
  const toolId = textValue(event.payload.tool_id) || `tool-${event.seq}`
  const tool = textValue(event.payload.tool) || 'Tool'
  const existing = actions.find((action) => action.toolId === toolId)
  const action: AiAction = {
    input: displayValue(event.payload.input) || existing?.input,
    label: tool,
    output: displayValue(event.payload.output) || existing?.output,
    status,
    tool,
    toolId,
  }
  return existing
    ? actions.map((current) => current.toolId === toolId ? action : current)
    : [...actions, action]
}

function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function permissionFromEvent(event: AgentEvent): PendingPermission | null {
  const requestId = textValue(event.payload.request_id)
  if (!requestId || !Array.isArray(event.payload.options)) return null
  const options = event.payload.options.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const option = value as Record<string, unknown>
    const id = textValue(option.id)
    const label = textValue(option.label)
    if (!id || !label) return []
    return [{ id, label, kind: textValue(option.kind) }]
  })
  return { requestId, tool: textValue(event.payload.tool) || 'Tool', options }
}

function agentName(id: Conversation['agent_id']): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
