import { useEffect, useState } from 'react'
import { DownloadSimple, Plus, User, UsersThree } from '@phosphor-icons/react'
import { trackEvent } from '@/lib/telemetry'

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  ApiError,
  type AgentDescriptor,
  type AgentId,
  type Conversation,
  type KubecodeApi,
  type Project,
  type ProviderSessionInfo,
  type TeamSnapshot,
} from '../api'
import { SystemMessageNotice } from '../SystemMessageNotice'
import { errorMessage } from './errors'
import type { Translator } from '@/lib/i18n'

export type NewSessionDialogProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  open: boolean
  project: Project | null
  projectId: string | null
  onOpenChange: (open: boolean) => void
  onOpenAgentSettings: () => void
  onRefreshAgents: () => Promise<void>
  onSession: (conversation: Conversation) => void
  onTeam: (team: TeamSnapshot) => void
  t: Translator
}

export function NewSessionDialog({
  agents,
  api,
  open,
  project,
  projectId,
  onOpenChange,
  onOpenAgentSettings,
  onRefreshAgents,
  onSession,
  onTeam,
  t,
}: NewSessionDialogProps) {
  const availableAgent = agents.find((agent) => agent.available)
  const [agentId, setAgentId] = useState<AgentId>(availableAgent?.id ?? 'codex')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'new' | 'import'>('new')
  const [sessionKind, setSessionKind] = useState<'session' | 'team'>('session')
  const [executionMode, setExecutionMode] = useState<'shared' | 'worktree'>('shared')
  const [providerSessions, setProviderSessions] = useState<ProviderSessionInfo[]>([])
  const [providerSessionId, setProviderSessionId] = useState<string | null>(null)
  const [loadingProviderSessions, setLoadingProviderSessions] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createFailure, setCreateFailure] = useState<ApiError | null>(null)

  const selectedAgentId = agents.some((agent) => agent.id === agentId && agent.available)
    ? agentId
    : availableAgent?.id ?? agentId

  useEffect(() => {
    if (open) setExecutionMode(project?.workspaces_enabled ? 'worktree' : 'shared')
  }, [open, project?.workspaces_enabled])

  useEffect(() => {
    if (!open || mode !== 'import' || !projectId || !availableAgent) return
    let current = true
    queueMicrotask(() => {
      if (!current) return
      setLoadingProviderSessions(true)
      setProviderError(null)
    })
    void api.listProviderSessions(projectId, selectedAgentId)
      .then((sessions) => {
        if (!current) return
        setProviderSessions(sessions)
        setProviderSessionId((selected) => sessions.some((item) => item.session_id === selected)
          ? selected
          : sessions[0]?.session_id ?? null)
      })
      .catch((cause: unknown) => {
        if (current) setProviderError(errorMessage(cause, t('kubecode.providerSessionsLoadFailed')))
      })
      .finally(() => {
        if (current) setLoadingProviderSessions(false)
      })
    return () => { current = false }
  }, [api, availableAgent, mode, open, projectId, selectedAgentId, t])

  const create = async () => {
    if (!projectId) return
    setCreating(true)
    setCreateError(null)
    setCreateFailure(null)
    try {
      if (mode === 'new' && sessionKind === 'team') {
        const team = await api.createTeam(
          projectId,
          selectedAgentId,
          agentName(selectedAgentId),
          title.trim() || undefined,
          executionMode,
        )
        trackEvent('kubecode_team_created', {
          leader_agent_id: selectedAgentId,
          execution_mode: executionMode,
        })
        setTitle('')
        onTeam(team)
        onOpenChange(false)
        return
      }
      const providerSession = providerSessions.find((item) => item.session_id === providerSessionId)
      const session = await api.createConversation(
        projectId,
        selectedAgentId,
        title.trim() || undefined,
        mode === 'import' ? providerSession?.session_id : undefined,
        mode === 'import' ? providerSession?.title ?? undefined : undefined,
        mode === 'new' ? executionMode : 'shared',
      )
      trackEvent(mode === 'import' ? 'kubecode_agent_session_imported' : 'kubecode_session_created', {
        agent_id: selectedAgentId,
        execution_mode: mode === 'new' ? executionMode : 'shared',
      })
      setTitle('')
      setProviderSessionId(null)
      onSession(session)
      onOpenChange(false)
    } catch (cause) {
      setCreateFailure(cause instanceof ApiError ? cause : null)
      setCreateError(agentStartupErrorMessage(cause, t))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="kubecode-new-session-dialog">
        <DialogHeader>
          <DialogTitle>{t('kubecode.newSession')}</DialogTitle>
          <DialogDescription>{t('kubecode.newSessionDescription')}</DialogDescription>
        </DialogHeader>
        <div className="kubecode-new-session-form">
          <div className="kubecode-choice-grid kubecode-session-choice-grid" role="group">
            <Button
              aria-label={t('kubecode.startNewSession')}
              aria-pressed={mode === 'new'}
              data-active={mode === 'new'}
              variant="outline"
              onClick={() => setMode('new')}
            >
              <Plus />
              <span>{t('kubecode.startNewSession')}</span>
            </Button>
            <Button
              aria-label={t('kubecode.importAgentSession')}
              aria-pressed={mode === 'import'}
              data-active={mode === 'import'}
              variant="outline"
              onClick={() => setMode('import')}
            >
              <DownloadSimple />
              <span>{t('kubecode.importAgentSession')}</span>
            </Button>
          </div>
          {mode === 'new' && (
            <div className="kubecode-new-session-field">
              <span>{t('kubecode.sessionType')}</span>
              <div className="kubecode-choice-grid kubecode-session-choice-grid" role="group" aria-label={t('kubecode.sessionType')}>
                <Button
                  aria-label={t('kubecode.session')}
                  aria-pressed={sessionKind === 'session'}
                  data-active={sessionKind === 'session'}
                  variant="outline"
                  onClick={() => setSessionKind('session')}
                >
                  <User />
                  <span>{t('kubecode.session')}</span>
                </Button>
                <Button
                  aria-label={t('kubecode.teamSession')}
                  aria-pressed={sessionKind === 'team'}
                  data-active={sessionKind === 'team'}
                  variant="outline"
                  onClick={() => setSessionKind('team')}
                >
                  <UsersThree />
                  <span>{t('kubecode.teamSession')}</span>
                </Button>
              </div>
            </div>
          )}
          <label className="kubecode-new-session-field">
            <span>{t('kubecode.agent')}</span>
            <Select value={selectedAgentId} onValueChange={(value) => setAgentId(value as AgentId)}>
              <SelectTrigger aria-label={t('kubecode.agent')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem disabled={!agent.available} key={agent.id} value={agent.id}>
                    <AiAgentIcon agent={agent.id} size={18} /> {agentName(agent.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {mode === 'new' ? (
            <>
              <label className="kubecode-new-session-field">
                <span>{sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.sessionTitle')}</span>
                <Input
                  aria-label={sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.sessionTitle')}
                  placeholder={sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.optionalSessionTitle')}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              {project?.workspaces_enabled && (
                <div className="kubecode-new-session-field">
                  <span>{t('kubecode.executionWorkspace')}</span>
                  <div className="kubecode-choice-grid" role="group" aria-label={t('kubecode.executionWorkspace')}>
                    <Button aria-pressed={executionMode === 'worktree'} data-active={executionMode === 'worktree'} variant="outline" onClick={() => setExecutionMode('worktree')}>
                      <span>{t('kubecode.newWorkspace')}</span>
                      <small>{t('kubecode.newWorkspaceDescription')}</small>
                    </Button>
                    <Button aria-pressed={executionMode === 'shared'} data-active={executionMode === 'shared'} variant="outline" onClick={() => setExecutionMode('shared')}>
                      <span>{t('kubecode.projectRoot')}</span>
                      <small>{t('kubecode.projectRootDescription')}</small>
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="kubecode-provider-session-list">
              {providerSessions.map((session) => (
                <Button
                  data-active={session.session_id === providerSessionId}
                  key={session.session_id}
                  variant={session.session_id === providerSessionId ? 'secondary' : 'ghost'}
                  onClick={() => setProviderSessionId(session.session_id)}
                >
                  <span>{session.title || t('kubecode.untitledSession')}</span>
                  <code>{session.updated_at ?? session.session_id}</code>
                </Button>
              ))}
              {loadingProviderSessions && <div className="kubecode-empty-small">{t('kubecode.loading')}</div>}
              {!loadingProviderSessions && providerSessions.length === 0 && !providerError && (
                <div className="kubecode-empty-small">{t('kubecode.noProviderSessions')}</div>
              )}
              {providerError && (
                <SystemMessageNotice
                  detailsLabel={t('kubecode.details')}
                  dismissLabel={t('window.close')}
                  level="error"
                  message={providerError}
                  onDismiss={() => setProviderError(null)}
                />
              )}
            </div>
          )}
          {createError && (
            <div className="kubecode-agent-startup-error">
              <SystemMessageNotice
                detailsLabel={t('kubecode.details')}
                dismissLabel={t('window.close')}
                level="error"
                message={createError}
                onDismiss={() => {
                  setCreateError(null)
                  setCreateFailure(null)
                }}
              />
              {createFailure && (
                <code className="kubecode-agent-startup-code">
                  {createFailure.code}
                  {createFailure.stage ? ` · ${createFailure.stage}` : ''}
                </code>
              )}
              <div>
                <Button
                  disabled={creating}
                  size="sm"
                  variant="outline"
                  onClick={() => void create()}
                >
                  {t('kubecode.retry')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onOpenAgentSettings}
                >
                  {t('kubecode.openAgentSettings')}
                </Button>
                {createFailure?.code === 'agent_unavailable' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void onRefreshAgents()}
                  >
                    {t('kubecode.checkAgain')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="kubecode-new-session-footer">
          <DialogClose asChild><Button disabled={creating} variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
          <Button
            aria-busy={creating}
            disabled={creating
              || !projectId
              || !availableAgent
              || (mode === 'import' && !providerSessionId)}
            onClick={() => void create()}
          >
            {creating ? t('kubecode.loading') : mode === 'import' ? t('kubecode.import') : t('kubecode.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function agentStartupErrorMessage(cause: unknown, t: Translator): string {
  if (!(cause instanceof ApiError)) return errorMessage(cause, t('kubecode.error'))
  switch (cause.code) {
    case 'agent_adapter_unavailable':
      return t('kubecode.agentError.adapter')
    case 'agent_process_spawn_failed':
      return t('kubecode.agentError.process')
    case 'agent_initialize_failed':
      return t('kubecode.agentError.initialize')
    case 'agent_session_new_failed':
      return t('kubecode.agentError.sessionNew')
    case 'agent_session_load_failed':
    case 'agent_session_resume_failed':
      return t('kubecode.agentError.sessionRestore')
    case 'agent_authentication_failed':
      return t('kubecode.agentError.authentication')
    case 'agent_project_directory_failed':
      return t('kubecode.agentError.directory')
    case 'agent_unavailable':
      return t('kubecode.agentError.unavailable')
    default:
      return errorMessage(cause, t('kubecode.error'))
  }
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}
