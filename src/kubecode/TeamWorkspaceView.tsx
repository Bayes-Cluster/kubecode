import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CheckCircle,
  Clock,
  GitBranch,
  ListChecks,
  SpinnerGap,
  UsersThree,
  WarningCircle,
} from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import type { TranslationKey } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type {
  AgentId,
  AgentSessionState,
  KubecodeApi,
  TeamMember,
  TeamMode,
  TeamSnapshot,
  TeamTask,
} from './api'
import { SystemMessageNotice } from './SystemMessageNotice'

type Translator = (key: TranslationKey) => string

export function TeamWorkspaceView({
  api,
  onSelectMember,
  onSnapshotChange,
  snapshot,
  t,
}: {
  api: KubecodeApi
  onSelectMember: (conversationId: string) => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const [error, setError] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [detailTab, setDetailTab] = useState<'tasks' | 'activity' | 'dependencies'>('tasks')
  const conversations = useMemo(
    () => new Map((snapshot.conversations ?? []).map((conversation) => [conversation.id, conversation])),
    [snapshot.conversations],
  )
  const tasks = useMemo(() => snapshot.tasks ?? [], [snapshot.tasks])
  const attention = snapshot.attention ?? []
  const activity = snapshot.activity ?? []
  const summary = snapshot.summary ?? {
    running: 0,
    queued: 0,
    needs_attention: 0,
    done: 0,
    total_tasks: tasks.length,
  }
  const tasksByColumn = useMemo(() => groupTasks(tasks), [tasks])

  if (snapshot.team.status === 'draft' || setupOpen) {
    return (
      <TeamSetup
        api={api}
        onCancel={snapshot.team.status === 'draft' ? undefined : () => setSetupOpen(false)}
        onSnapshotChange={onSnapshotChange}
        snapshot={snapshot}
        t={t}
      />
    )
  }

  return (
    <section className="kubecode-team-workspace" data-testid="team-workspace-view">
      <header className="kubecode-team-control-header">
        <div>
          <UsersThree weight="fill" />
          <div>
            <strong>{snapshot.team.title || snapshot.leader_conversation.title}</strong>
            <span>{t('kubecode.teamControlCenter')}</span>
          </div>
        </div>
        <div className="kubecode-team-settings">
          <span className="kubecode-team-status" data-status={snapshot.team.status}>
            {teamStatusLabel(snapshot.team.status, t)}
          </span>
          <span>{snapshot.team.mode === 'yolo' ? t('kubecode.teamYolo') : t('kubecode.teamStandard')}</span>
          <span>{t('kubecode.teamConcurrency')}: {snapshot.team.max_parallel_runs}</span>
          {snapshot.team.status === 'needs_attention' && (
            <Button size="sm" variant="outline" onClick={() => setSetupOpen(true)}>
              {t('kubecode.teamReconfigure')}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <SystemMessageNotice
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      <div className="kubecode-team-metrics">
        <Metric icon={<SpinnerGap />} label={t('kubecode.teamRunning')} name="running" value={summary.running} />
        <Metric icon={<Clock />} label={t('kubecode.teamQueued')} name="queued" value={summary.queued} />
        <Metric icon={<WarningCircle />} label={t('kubecode.teamNeedsAttention')} name="attention" value={summary.needs_attention} />
        <Metric icon={<CheckCircle />} label={t('kubecode.teamDone')} name="done" value={summary.done} />
      </div>

      {attention.length > 0 && (
        <section className="kubecode-team-attention">
          <header><WarningCircle weight="fill" /> {t('kubecode.teamNeedsAttention')}</header>
          <div>
            {attention.map((attentionItem) => (
              <Button
                key={attentionItem.id}
                size="sm"
                variant="ghost"
                onClick={() => {
                  const member = snapshot.members.find((candidate) => candidate.id === attentionItem.member_id)
                  if (member) onSelectMember(member.conversation_id)
                }}
              >
                <span>{attentionItem.summary}</span>
                <ArrowRight />
              </Button>
            ))}
          </div>
        </section>
      )}

      {snapshot.discrimination_rounds?.length > 0 && (
        <section className="kubecode-team-verification">
          <header><CheckCircle /> {t('kubecode.teamVerification')}</header>
          {snapshot.discrimination_rounds.map((round) => (
            <div key={round.id} data-status={round.status}>
              <strong>{t('kubecode.teamVerificationRound')} {round.round}</strong>
              <span>{round.status}</span>
              {round.verdict && <p>{round.verdict}</p>}
            </div>
          ))}
        </section>
      )}

      <div className="kubecode-team-workspace-body" data-testid="team-workspace-body">
        <Tabs
          className="kubecode-team-detail-tabs"
          value={detailTab}
          onValueChange={(value) => setDetailTab(value as typeof detailTab)}
        >
          <TabsList>
            <TabsTrigger value="tasks" onClick={() => setDetailTab('tasks')}>
              <ListChecks /> {t('kubecode.teamTasks')}
            </TabsTrigger>
            <TabsTrigger value="activity" onClick={() => setDetailTab('activity')}>
              <Clock /> {t('kubecode.teamActivity')}
            </TabsTrigger>
            <TabsTrigger value="dependencies" onClick={() => setDetailTab('dependencies')}>
              <GitBranch /> {t('kubecode.teamDependencies')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tasks">
            <div className="kubecode-team-board">
              {TASK_COLUMNS.map((column) => (
                <section
                  data-column={column.id}
                  data-testid={`team-board-column-${column.id}`}
                  key={column.id}
                >
                  <header>
                    <span><i />{t(column.label)}</span>
                    <small>{tasksByColumn[column.id].length}</small>
                  </header>
                  <div>
                    {tasksByColumn[column.id].map((task) => (
                      <TaskCard
                        conversations={conversations}
                        key={task.id}
                        members={snapshot.members}
                        onSelectMember={onSelectMember}
                        task={task}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="activity">
            <ol className="kubecode-team-activity-list">
              {activity.map((activityItem) => (
                <li key={activityItem.id}>
                  <i data-kind={activityItem.kind} />
                  <div><strong>{activityItem.summary}</strong><time>{activityItem.created_at}</time></div>
                </li>
              ))}
              {activity.length === 0 && <li>{t('kubecode.teamNoActivity')}</li>}
            </ol>
          </TabsContent>
          <TabsContent value="dependencies">
            <div className="kubecode-team-dependency-list">
              {tasks.map((task) => (
                <div key={task.id}>
                  <strong>{task.title}</strong>
                  {task.dependencies.length > 0
                    ? task.dependencies.map((dependency) => {
                      const parent = tasks.find((candidate) => candidate.id === dependency)
                      return <span key={dependency}><ArrowRight /> {parent?.title || dependency}</span>
                    })
                    : <span>{t('kubecode.teamNoDependencies')}</span>}
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  )
}

function TeamSetup({
  api,
  onCancel,
  onSnapshotChange,
  snapshot,
  t,
}: {
  api: KubecodeApi
  onCancel?: () => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const [goal, setGoal] = useState(snapshot.team.goal)
  const [criteria, setCriteria] = useState(snapshot.team.acceptance_criteria.join('\n'))
  const [mode, setMode] = useState<TeamMode>(snapshot.team.mode)
  const [allowedAgents, setAllowedAgents] = useState<AgentId[]>(snapshot.team.allowed_agent_ids)
  const [availableAgents, setAvailableAgents] = useState<AgentId[]>([])
  const [maxTeammates, setMaxTeammates] = useState(snapshot.team.max_teammates || 3)
  const [maxParallelRuns, setMaxParallelRuns] = useState(snapshot.team.max_parallel_runs || 2)
  const [maxReviewRounds, setMaxReviewRounds] = useState(snapshot.team.max_review_rounds || 3)
  const [sessionState, setSessionState] = useState<AgentSessionState | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([
      api.listAgents(),
      api.getSessionState(snapshot.leader_conversation.id),
    ]).then(([agents, state]) => {
      if (!active) return
      const available = agents.filter((agent) => agent.available).map((agent) => agent.id)
      setAvailableAgents(available)
      setAllowedAgents((current) => {
        const installed = current.filter((agentId) => available.includes(agentId))
        return installed.length > 0 ? installed : available
      })
      setSessionState(state)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    })
    return () => { active = false }
  }, [api, snapshot.leader_conversation.id, t])

  const toggleAgent = (agentId: AgentId) => {
    setAllowedAgents((current) => current.includes(agentId)
      ? current.filter((candidate) => candidate !== agentId)
      : [...current, agentId])
  }

  const start = async () => {
    const acceptanceCriteria = criteria.split('\n').map((value) => value.trim()).filter(Boolean)
    if (!goal.trim() || acceptanceCriteria.length === 0 || allowedAgents.length === 0) return
    setStarting(true)
    setError(null)
    try {
      const concurrency = Math.min(maxParallelRuns, maxTeammates)
      const updated = await api.startTeam(snapshot.team.id, {
        goal: goal.trim(),
        acceptance_criteria: acceptanceCriteria,
        allowed_agent_ids: allowedAgents,
        mode,
        max_teammates: maxTeammates,
        max_parallel_runs: concurrency,
        max_review_rounds: maxReviewRounds,
      })
      trackEvent('kubecode_team_started', {
        leader_agent_id: snapshot.leader_conversation.agent_id,
        mode,
        max_teammates: maxTeammates,
        max_parallel_runs: concurrency,
      })
      onSnapshotChange(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="kubecode-team-workspace kubecode-team-setup" data-testid="team-setup">
      <header>
        <UsersThree weight="fill" />
        <div>
          <strong>{snapshot.team.title || snapshot.leader_conversation.title}</strong>
          <span>{t('kubecode.teamSetupDescription')}</span>
        </div>
      </header>

      {error && (
        <SystemMessageNotice
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      <div className="kubecode-team-setup-grid">
        <label className="kubecode-new-session-field">
          <span>{t('kubecode.teamGoal')}</span>
          <Textarea
            aria-label={t('kubecode.teamGoal')}
            placeholder={t('kubecode.teamGoalPlaceholder')}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label className="kubecode-new-session-field">
          <span>{t('kubecode.teamAcceptanceCriteria')}</span>
          <Textarea
            aria-label={t('kubecode.teamAcceptanceCriteria')}
            placeholder={t('kubecode.teamAcceptanceCriteriaPlaceholder')}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </label>

        <div className="kubecode-new-session-field">
          <span>{t('kubecode.teamMode')}</span>
          <div className="kubecode-choice-grid" role="group" aria-label={t('kubecode.teamMode')}>
            <Button aria-pressed={mode === 'standard'} data-active={mode === 'standard'} variant="outline" onClick={() => setMode('standard')}>
              <span>{t('kubecode.teamStandard')}</span>
              <small>{t('kubecode.teamStandardDescription')}</small>
            </Button>
            <Button aria-pressed={mode === 'yolo'} data-active={mode === 'yolo'} variant="outline" onClick={() => setMode('yolo')}>
              <span>{t('kubecode.teamYolo')}</span>
              <small>{t('kubecode.teamYoloDescription')}</small>
            </Button>
          </div>
          {mode === 'yolo' && <p className="kubecode-team-yolo-warning">{t('kubecode.teamYoloWarning')}</p>}
        </div>

        <div className="kubecode-new-session-field">
          <span>{t('kubecode.teamAllowedAgents')}</span>
          <div className="kubecode-team-agent-budget">
            {(['claude_code', 'codex', 'opencode'] as const).map((agentId) => (
              <Button
                aria-pressed={allowedAgents.includes(agentId)}
                data-active={allowedAgents.includes(agentId)}
                disabled={!availableAgents.includes(agentId)}
                key={agentId}
                size="sm"
                variant="outline"
                onClick={() => toggleAgent(agentId)}
              >
                <AiAgentIcon agent={agentId} size={16} />
                {agentName(agentId)}
              </Button>
            ))}
          </div>
        </div>

        <NativeLeaderOptions
          api={api}
          conversationId={snapshot.leader_conversation.id}
          sessionState={sessionState}
          setSessionState={setSessionState}
          t={t}
        />

        <div className="kubecode-team-budget-grid">
          <NumberSelect
            label={t('kubecode.teamMemberLimit')}
            max={8}
            onChange={(value) => {
              setMaxTeammates(value)
              setMaxParallelRuns((current) => Math.min(current, value))
            }}
            value={maxTeammates}
          />
          <NumberSelect label={t('kubecode.teamConcurrency')} max={maxTeammates} onChange={setMaxParallelRuns} value={maxParallelRuns} />
          {mode === 'yolo' && (
            <NumberSelect label={t('kubecode.teamReviewRounds')} max={10} onChange={setMaxReviewRounds} value={maxReviewRounds} />
          )}
        </div>
      </div>

      <footer>
        {onCancel && <Button variant="ghost" onClick={onCancel}>{t('kubecode.cancel')}</Button>}
        <Button
          aria-busy={starting}
          disabled={starting || !goal.trim() || !criteria.trim() || allowedAgents.length === 0}
          onClick={() => void start()}
        >
          {starting ? t('kubecode.loading') : t('kubecode.teamStart')}
        </Button>
      </footer>
    </section>
  )
}

function NumberSelect({ label, max, onChange, value }: {
  label: string
  max: number
  onChange: (value: number) => void
  value: number
}) {
  return (
    <label>
      <span>{label}</span>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {Array.from({ length: max }, (_, index) => index + 1).map((option) => (
            <SelectItem key={option} value={String(option)}>{option}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

function NativeLeaderOptions({ api, conversationId, sessionState, setSessionState, t }: {
  api: KubecodeApi
  conversationId: string
  sessionState: AgentSessionState | null
  setSessionState: (state: AgentSessionState | null) => void
  t: Translator
}) {
  const options = nativeSessionSelects(sessionState)
  if (options.length === 0) return null
  return (
    <div className="kubecode-new-session-field">
      <span>{t('kubecode.teamLeaderConfiguration')}</span>
      <div className="kubecode-team-native-options">
        {options.map((option) => (
          <label key={`${option.kind}:${option.id}`}>
            <span>{option.kind === 'mode' ? t('kubecode.agentMode') : option.name}</span>
            <Select
              value={option.currentValue}
              onValueChange={(value) => {
                const request = option.kind === 'mode'
                  ? api.setSessionMode(conversationId, value)
                  : api.setSessionConfig(conversationId, option.id, value)
                void request.then(() => api.getSessionState(conversationId)).then(setSessionState)
              }}
            >
              <SelectTrigger aria-label={option.kind === 'mode' ? t('kubecode.agentMode') : option.name}><SelectValue /></SelectTrigger>
              <SelectContent>
                {option.options.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ))}
      </div>
    </div>
  )
}

type NativeSelect = {
  id: string
  kind: 'mode' | 'config'
  name: string
  currentValue: string
  options: Array<{ name: string; value: string }>
}

function nativeSessionSelects(state: AgentSessionState | null): NativeSelect[] {
  const result: NativeSelect[] = []
  const mode = state?.current_mode
  const modeOptions = selectValues(mode?.availableModes)
  if (typeof mode?.currentModeId === 'string' && modeOptions.length > 0) {
    result.push({ id: 'mode', kind: 'mode', name: 'Mode', currentValue: mode.currentModeId, options: modeOptions })
  }
  const configs = state?.config_options?.configOptions
  if (!Array.isArray(configs)) return result
  for (const value of configs) {
    if (!value || typeof value !== 'object') continue
    const config = value as Record<string, unknown>
    const options = selectValues(config.options)
    if (
      config.type === 'select'
      && typeof config.id === 'string'
      && typeof config.name === 'string'
      && typeof config.currentValue === 'string'
      && options.length > 0
    ) {
      result.push({ id: config.id, kind: 'config', name: config.name, currentValue: config.currentValue, options })
    }
  }
  return result
}

function selectValues(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const option = item as Record<string, unknown>
    const id = typeof option.value === 'string'
      ? option.value
      : typeof option.id === 'string'
        ? option.id
        : null
    if (!id) return []
    return [{ name: typeof option.name === 'string' ? option.name : id, value: id }]
  })
}

function teamStatusLabel(status: TeamSnapshot['team']['status'], t: Translator): string {
  const keys = {
    draft: 'kubecode.teamStatusDraft',
    active: 'kubecode.teamStatusActive',
    verifying: 'kubecode.teamStatusVerifying',
    needs_attention: 'kubecode.teamNeedsAttention',
    completed: 'kubecode.teamStatusCompleted',
    archived: 'kubecode.teamStatusArchived',
  } as const satisfies Record<TeamSnapshot['team']['status'], TranslationKey>
  return t(keys[status] ?? keys.active)
}

const TASK_COLUMNS = [
  { id: 'backlog', label: 'kubecode.teamBacklog' },
  { id: 'ready', label: 'kubecode.teamReady' },
  { id: 'in_progress', label: 'kubecode.teamInProgress' },
  { id: 'review', label: 'kubecode.teamReview' },
  { id: 'done', label: 'kubecode.teamDone' },
] as const satisfies ReadonlyArray<{ id: TaskColumn; label: TranslationKey }>

type TaskColumn = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done'

function groupTasks(tasks: TeamTask[]): Record<TaskColumn, TeamTask[]> {
  const grouped: Record<TaskColumn, TeamTask[]> = {
    backlog: [], ready: [], in_progress: [], review: [], done: [],
  }
  for (const task of tasks) grouped[taskColumn(task.status)].push(task)
  return grouped
}

function taskColumn(status: string): TaskColumn {
  if (status === 'blocked' || status === 'cancelled') return 'backlog'
  if (status === 'pending') return 'ready'
  if (status === 'in_progress' || status === 'changes_requested') return 'in_progress'
  if (status === 'plan_review' || status === 'result_review') return 'review'
  return 'done'
}

function Metric({ icon, label, name, value }: {
  icon: React.ReactNode
  label: string
  name: string
  value: number
}) {
  return <div data-metric={name}>{icon}<span><strong>{value}</strong><small>{label}</small></span></div>
}

function TaskCard({
  conversations,
  members,
  onSelectMember,
  task,
}: {
  conversations: Map<string, TeamSnapshot['conversations'][number]>
  members: TeamMember[]
  onSelectMember: (conversationId: string) => void
  task: TeamTask
}) {
  const assignee = members.find((member) => member.id === task.assignee_member_id)
  const conversation = assignee ? conversations.get(assignee.conversation_id) : undefined
  return (
    <article
      className="kubecode-team-task-card"
      data-status={task.status}
      data-testid={`team-task-card-${task.id}`}
    >
      <strong>{task.title}</strong>
      <footer>
        {assignee && conversation ? (
          <Button
            aria-label={assignee.name}
            size="sm"
            variant="ghost"
            onClick={() => onSelectMember(assignee.conversation_id)}
          >
            <AiAgentIcon agent={conversation.agent_id} size={14} />
            <span>{assignee.name}</span>
          </Button>
        ) : <span>—</span>}
      </footer>
    </article>
  )
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}
