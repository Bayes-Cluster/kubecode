import { useMemo, useState } from 'react'
import {
  ArrowRight,
  CheckCircle,
  Clock,
  GitBranch,
  ListChecks,
  SidebarSimple,
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
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { TranslationKey } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type { KubecodeApi, TeamMember, TeamSnapshot, TeamTask } from './api'
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
  const [detailTab, setDetailTab] = useState<'tasks' | 'activity' | 'dependencies'>('tasks')
  const [memberRailCollapsed, setMemberRailCollapsed] = useState(false)
  const conversations = useMemo(
    () => new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation])),
    [snapshot.conversations],
  )
  const tasksByColumn = useMemo(() => groupTasks(snapshot.tasks), [snapshot.tasks])

  const updateSettings = async (
    policy: TeamSnapshot['team']['member_management_policy'],
    parallelRuns: number,
  ) => {
    setError(null)
    try {
      const updated = await api.updateTeamSettings(snapshot.team.id, policy, parallelRuns)
      onSnapshotChange(updated)
      trackEvent('kubecode_team_settings_changed', {
        auto_manage: policy === 'auto' ? 1 : 0,
        max_parallel_runs: parallelRuns,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    }
  }

  const resolveProposal = async (decision: 'approved' | 'rejected') => {
    if (!snapshot.proposal) return
    setError(null)
    try {
      const updated = await api.resolveTeamProposal(
        snapshot.team.id,
        snapshot.proposal.id,
        decision,
      )
      onSnapshotChange(updated)
      trackEvent('kubecode_team_proposal_resolved', { decision })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    }
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
          <label>
            <span>{t('kubecode.teamAutoManage')}</span>
            <Switch
              aria-label={t('kubecode.teamAutoManage')}
              checked={snapshot.team.member_management_policy === 'auto'}
              onCheckedChange={(checked) => void updateSettings(
                checked ? 'auto' : 'ask',
                snapshot.team.max_parallel_runs,
              )}
            />
          </label>
          <Select
            value={String(snapshot.team.max_parallel_runs)}
            onValueChange={(value) => void updateSettings(
              snapshot.team.member_management_policy,
              Number(value),
            )}
          >
            <SelectTrigger aria-label={t('kubecode.teamConcurrency')} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 8 }, (_, index) => index + 1).map((value) => (
                <SelectItem key={value} value={String(value)}>{value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        <Metric icon={<SpinnerGap />} label={t('kubecode.teamRunning')} name="running" value={snapshot.summary.running} />
        <Metric icon={<Clock />} label={t('kubecode.teamQueued')} name="queued" value={snapshot.summary.queued} />
        <Metric icon={<WarningCircle />} label={t('kubecode.teamNeedsAttention')} name="attention" value={snapshot.summary.needs_attention} />
        <Metric icon={<CheckCircle />} label={t('kubecode.teamDone')} name="done" value={snapshot.summary.done} />
      </div>

      {snapshot.proposal?.status === 'pending' && (
        <ProposalCard
          proposal={snapshot.proposal}
          onResolve={(decision) => void resolveProposal(decision)}
          t={t}
        />
      )}

      {snapshot.attention.length > 0 && (
        <section className="kubecode-team-attention">
          <header><WarningCircle weight="fill" /> {t('kubecode.teamNeedsAttention')}</header>
          <div>
            {snapshot.attention.map((attention) => (
              <Button
                key={attention.id}
                size="sm"
                variant="ghost"
                onClick={() => {
                  const member = snapshot.members.find((candidate) => candidate.id === attention.member_id)
                  if (member) onSelectMember(member.conversation_id)
                }}
              >
                <span>{attention.summary}</span>
                <ArrowRight />
              </Button>
            ))}
          </div>
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
                <section key={column.id}>
                  <header>
                    <span>{t(column.label)}</span>
                    <small>{tasksByColumn[column.id].length}</small>
                  </header>
                  <div>
                    {tasksByColumn[column.id].map((task) => (
                      <TaskCard
                        conversations={conversations}
                        key={task.id}
                        members={snapshot.members}
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
              {snapshot.activity.map((activity) => (
                <li key={activity.id}>
                  <i data-kind={activity.kind} />
                  <div><strong>{activity.summary}</strong><time>{activity.created_at}</time></div>
                </li>
              ))}
              {snapshot.activity.length === 0 && <li>{t('kubecode.teamNoActivity')}</li>}
            </ol>
          </TabsContent>
          <TabsContent value="dependencies">
            <div className="kubecode-team-dependency-list">
              {snapshot.tasks.map((task) => (
                <div key={task.id}>
                  <strong>{task.title}</strong>
                  {task.dependencies.length > 0
                    ? task.dependencies.map((dependency) => {
                      const parent = snapshot.tasks.find((candidate) => candidate.id === dependency)
                      return <span key={dependency}><ArrowRight /> {parent?.title || dependency}</span>
                    })
                    : <span>{t('kubecode.teamNoDependencies')}</span>}
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>

        <section
          className="kubecode-team-members"
          data-collapsed={memberRailCollapsed}
          data-testid="team-member-rail"
        >
          <header>
            <span>{t('kubecode.teamMembers')}</span>
            <Button
              aria-label={t(memberRailCollapsed ? 'sidebar.action.expand' : 'sidebar.action.collapse')}
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                setMemberRailCollapsed((collapsed) => {
                  trackEvent('kubecode_team_member_rail_toggled', { collapsed: collapsed ? 0 : 1 })
                  return !collapsed
                })
              }}
            >
              <SidebarSimple />
            </Button>
          </header>
          <div>
            {snapshot.members.map((member) => {
              const conversation = conversations.get(member.conversation_id)
              if (!conversation) return null
              return (
                <Button
                  aria-label={`${member.name} ${t(memberStatusKey(member.status))}`}
                  className="kubecode-team-member-row"
                  key={member.id}
                  variant="ghost"
                  onClick={() => onSelectMember(member.conversation_id)}
                >
                  <AiAgentIcon agent={conversation.agent_id} size={22} />
                  <span className="kubecode-team-member-copy">
                    <strong>{member.name}</strong>
                    <small>{member.role === 'leader' ? t('kubecode.teamLeader') : t('kubecode.teamTeammate')}</small>
                  </span>
                  <span className="kubecode-team-runtime-state" data-status={member.status}>
                    <i /><span>{t(memberStatusKey(member.status))}</span>
                  </span>
                </Button>
              )
            })}
          </div>
        </section>
      </div>
    </section>
  )
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
  task,
}: {
  conversations: Map<string, TeamSnapshot['conversations'][number]>
  members: TeamMember[]
  task: TeamTask
}) {
  const assignee = members.find((member) => member.id === task.assignee_member_id)
  const conversation = assignee ? conversations.get(assignee.conversation_id) : undefined
  return (
    <article className="kubecode-team-task-card" data-status={task.status}>
      <strong>{task.title}</strong>
      <footer>
        {conversation && <AiAgentIcon agent={conversation.agent_id} size={14} />}
        <span>{assignee?.name || '—'}</span>
      </footer>
    </article>
  )
}

function ProposalCard({ proposal, onResolve, t }: {
  proposal: TeamSnapshot['proposal'] & {}
  onResolve: (decision: 'approved' | 'rejected') => void
  t: Translator
}) {
  const members = parseProposalMembers(proposal.members_json)
  return (
    <section className="kubecode-team-proposal">
      <header>{t('kubecode.teamProposedLineup')}</header>
      <p>{proposal.summary}</p>
      <div>{members.map((member, index) => <span key={`${index}-${member}`}>{member}</span>)}</div>
      <footer>
        <Button size="sm" variant="outline" onClick={() => onResolve('rejected')}>{t('kubecode.reject')}</Button>
        <Button size="sm" onClick={() => onResolve('approved')}>{t('kubecode.approve')}</Button>
      </footer>
    </section>
  )
}

function parseProposalMembers(value: string): string[] {
  try {
    const members = JSON.parse(value) as Array<Record<string, unknown>>
    return members.map((member) => [member.name, member.agent_id, member.purpose]
      .filter((part) => typeof part === 'string' && part)
      .join(' · '))
  } catch {
    return []
  }
}

function memberStatusKey(status: TeamMember['status']): TranslationKey {
  const keys: Record<TeamMember['status'], TranslationKey> = {
    starting: 'kubecode.teamStatusStarting',
    configuring: 'kubecode.teamStatusConfiguring',
    queued: 'kubecode.teamStatusQueued',
    idle: 'kubecode.teamStatusIdle',
    working: 'kubecode.teamStatusWorking',
    waiting_input: 'kubecode.teamStatusWaitingInput',
    waiting_permission: 'kubecode.teamStatusWaitingPermission',
    failed: 'kubecode.teamStatusFailed',
    stopped: 'kubecode.teamStatusStopped',
  }
  return keys[status]
}
