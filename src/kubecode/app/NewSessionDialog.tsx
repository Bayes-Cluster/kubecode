import { useEffect, useState } from 'react'
import {
  Download,
  Plus,
  User,
  Users,
} from 'lucide-react'
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
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

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
        <FieldGroup className="kubecode-new-session-form">
          <ToggleGroup
            aria-label={t('kubecode.newSession')}
            className="w-full"
            type="single"
            value={mode}
            variant="outline"
            onValueChange={(value) => {
              if (value === 'new' || value === 'import') setMode(value)
            }}
          >
            <ToggleGroupItem className="flex-1" value="new">
              <Plus />
              {t('kubecode.startNewSession')}
            </ToggleGroupItem>
            <ToggleGroupItem className="flex-1" value="import">
              <Download />
              {t('kubecode.importAgentSession')}
            </ToggleGroupItem>
          </ToggleGroup>
          {mode === 'new' && (
            <FieldSet>
              <FieldLegend variant="label">{t('kubecode.sessionType')}</FieldLegend>
              <ToggleGroup
                aria-label={t('kubecode.sessionType')}
                className="w-full"
                type="single"
                value={sessionKind}
                variant="outline"
                onValueChange={(value) => {
                  if (value === 'session' || value === 'team') setSessionKind(value)
                }}
              >
                <ToggleGroupItem className="flex-1" value="session">
                  <User />
                  {t('kubecode.session')}
                </ToggleGroupItem>
                <ToggleGroupItem className="flex-1" value="team">
                  <Users />
                  {t('kubecode.teamSession')}
                </ToggleGroupItem>
              </ToggleGroup>
            </FieldSet>
          )}
          <Field>
            <FieldLabel htmlFor="new-session-agent">{t('kubecode.agent')}</FieldLabel>
            <Select value={selectedAgentId} onValueChange={(value) => setAgentId(value as AgentId)}>
              <SelectTrigger aria-label={t('kubecode.agent')} className="w-full" id="new-session-agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {agents.map((agent) => (
                    <SelectItem disabled={!agent.available} key={agent.id} value={agent.id}>
                      <AiAgentIcon agent={agent.id} size={18} /> {agentName(agent.id)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {mode === 'new' ? (
            <>
              <Field>
                <FieldLabel htmlFor="new-session-title">
                  {sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.sessionTitle')}
                </FieldLabel>
                <Input
                  id="new-session-title"
                  placeholder={sessionKind === 'team' ? t('kubecode.teamName') : t('kubecode.optionalSessionTitle')}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              {project?.workspaces_enabled && (
                <FieldSet>
                  <FieldLegend variant="label">{t('kubecode.executionWorkspace')}</FieldLegend>
                  <RadioGroup
                    aria-label={t('kubecode.executionWorkspace')}
                    className="grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]"
                    value={executionMode}
                    onValueChange={(value) => {
                      if (value === 'worktree' || value === 'shared') setExecutionMode(value)
                    }}
                  >
                    {([
                      ['worktree', 'kubecode.newWorkspace', 'kubecode.newWorkspaceDescription'],
                      ['shared', 'kubecode.projectRoot', 'kubecode.projectRootDescription'],
                    ] as const).map(([value, title, description]) => (
                      <FieldLabel htmlFor={`new-session-workspace-${value}`} key={value}>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldTitle>{t(title)}</FieldTitle>
                            <FieldDescription>{t(description)}</FieldDescription>
                          </FieldContent>
                          <RadioGroupItem id={`new-session-workspace-${value}`} value={value} />
                        </Field>
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                </FieldSet>
              )}
            </>
          ) : (
            <ItemGroup className="kubecode-provider-session-list gap-1">
              {providerSessions.map((session) => (
                <Item
                  asChild
                  key={session.session_id}
                  size="sm"
                  variant={session.session_id === providerSessionId ? 'muted' : 'outline'}
                >
                  <button
                    aria-pressed={session.session_id === providerSessionId}
                    data-active={session.session_id === providerSessionId}
                    type="button"
                    onClick={() => setProviderSessionId(session.session_id)}
                  >
                    <ItemContent>
                      <ItemTitle>{session.title || t('kubecode.untitledSession')}</ItemTitle>
                      <ItemDescription className="font-mono">{session.updated_at ?? session.session_id}</ItemDescription>
                    </ItemContent>
                  </button>
                </Item>
              ))}
              {loadingProviderSessions && (
                <Empty><EmptyHeader><EmptyDescription>{t('kubecode.loading')}</EmptyDescription></EmptyHeader></Empty>
              )}
              {!loadingProviderSessions && providerSessions.length === 0 && !providerError && (
                <Empty><EmptyHeader><EmptyDescription>{t('kubecode.noProviderSessions')}</EmptyDescription></EmptyHeader></Empty>
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
            </ItemGroup>
          )}
          {createError && (
            <div className="flex flex-col gap-2">
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
                <code className="text-xs text-muted-foreground">
                  {createFailure.code}
                  {createFailure.stage ? ` · ${createFailure.stage}` : ''}
                </code>
              )}
              <div className="flex flex-wrap gap-2">
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
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild><Button disabled={creating} variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
          <Button
            aria-busy={creating}
            disabled={creating
              || !projectId
              || !availableAgent
              || (mode === 'import' && !providerSessionId)}
            onClick={() => void create()}
          >
            {creating && <Spinner data-icon="inline-start" />}
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
