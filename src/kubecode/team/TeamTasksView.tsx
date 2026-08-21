import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Clock,
  GitBranch,
  ListChecks,
  RefreshCw,
  Trash2
} from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { KubecodeApi, TeamMember, TeamSnapshot, TeamTask } from '../api'

export function TeamTasksView({
  api,
  busyAction,
  onSelectMember,
  onSnapshotChange,
  setBusyAction,
  setError,
  snapshot,
  t,
}: {
  api: KubecodeApi
  busyAction: string | null
  onSelectMember: (conversationId: string) => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  setBusyAction: (value: string | null) => void
  setError: (value: string | null) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'tasks' | 'activity' | 'dependencies'>('tasks')
  const conversations = useMemo(
    () => new Map((snapshot.conversations ?? []).map((conversation) => [conversation.id, conversation])),
    [snapshot.conversations],
  )
  const tasks = useMemo(() => snapshot.tasks ?? [], [snapshot.tasks])
  const activity = useMemo(() => snapshot.activity ?? [], [snapshot.activity])
  const tasksByColumn = useMemo(() => groupTasks(tasks), [tasks])
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null

  return (
    <>
      <div className="kubecode-team-workspace-body" data-testid="team-workspace-body">
        <Tabs
          className="kubecode-team-detail-tabs"
          value={detailTab}
          onValueChange={(value) => setDetailTab(value as typeof detailTab)}
        >
          <TabsList>
            <TabsTrigger value="tasks" onClick={() => setDetailTab('tasks')}>
              <ListChecks  size={16}/> {t('kubecode.teamTasks')}
            </TabsTrigger>
            <TabsTrigger value="activity" onClick={() => setDetailTab('activity')}>
              <Clock  size={16}/> {t('kubecode.teamActivity')}
            </TabsTrigger>
            <TabsTrigger value="dependencies" onClick={() => setDetailTab('dependencies')}>
              <GitBranch  size={16}/> {t('kubecode.teamDependencies')}
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
                        onSelectTask={setSelectedTaskId}
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
                      return <span key={dependency}><ArrowRight  size={16}/> {parent?.title || dependency}</span>
                    })
                    : <span>{t('kubecode.teamNoDependencies')}</span>}
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <TaskInspector
        api={api}
        busyAction={busyAction}
        members={snapshot.members}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null)
        }}
        onSelectMember={onSelectMember}
        onSnapshotChange={onSnapshotChange}
        setBusyAction={setBusyAction}
        setError={setError}
        snapshot={snapshot}
        task={selectedTask}
        t={t}
      />
    </>
  )
}

function TaskInspector({
  api,
  busyAction,
  members,
  onOpenChange,
  onSelectMember,
  onSnapshotChange,
  setBusyAction,
  setError,
  snapshot,
  task,
  t,
}: {
  api: KubecodeApi
  busyAction: string | null
  members: TeamMember[]
  onOpenChange: (open: boolean) => void
  onSelectMember: (conversationId: string) => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  setBusyAction: (value: string | null) => void
  setError: (value: string | null) => void
  snapshot: TeamSnapshot
  task: TeamTask | null
  t: Translator
}) {
  const [confirmation, setConfirmation] = useState<'cancel' | 'remove' | null>(null)
  const assignee = members.find((member) => member.id === task?.assignee_member_id)
  const teammates = members.filter((member) => (
    member.role === 'teammate' && !['removed', 'removing'].includes(member.status)
  ))
  const act = async (key: string, request: () => Promise<TeamSnapshot>) => {
    setBusyAction(key)
    setError(null)
    try {
      onSnapshotChange(await request())
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <>
      <Dialog open={Boolean(task)} onOpenChange={onOpenChange}>
        <DialogContent className="kubecode-team-task-dialog">
          {task && (
            <>
            <DialogHeader>
              <DialogTitle>{task.title}</DialogTitle>
              <DialogDescription>{t('kubecode.teamTaskDetails')}</DialogDescription>
            </DialogHeader>
            <div className="kubecode-team-task-dialog-body">
              <dl>
                <div><dt>{t('kubecode.teamTaskStatus')}</dt><dd>{task.status}</dd></div>
                <div>
                  <dt>{t('kubecode.teamTaskAssignee')}</dt>
                  <dd>{assignee?.name ?? t('kubecode.teamTaskUnassigned')}</dd>
                </div>
              </dl>
              {task.description && (
                <section>
                  <strong>{t('kubecode.teamTaskDescription')}</strong>
                  <p>{task.description}</p>
                </section>
              )}
              {task.result && (
                <section>
                  <strong>{t('kubecode.teamTaskResult')}</strong>
                  <p>{task.result}</p>
                </section>
              )}
              {task.verification && (
                <section>
                  <strong>{t('kubecode.teamTaskVerification')}</strong>
                  <p>{task.verification}</p>
                </section>
              )}
              {!task.assignee_member_id && task.status === 'pending' && teammates.length > 0 && (
                <label>
                  <span>{t('kubecode.teamTaskAssign')}</span>
                  <Select
                    onValueChange={(memberId) => void act(
                      `assign:${task.id}`,
                      () => api.assignTeamTask(snapshot.team.id, task.id, memberId),
                    )}
                  >
                    <SelectTrigger aria-label={t('kubecode.teamTaskAssign')}>
                      <SelectValue placeholder={t('kubecode.teamTaskUnassigned')} />
                    </SelectTrigger>
                    <SelectContent>
                      {teammates.map((member) => (
                        <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
            </div>
            <DialogFooter className="kubecode-team-task-dialog-actions">
              {assignee && (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      onSelectMember(assignee.conversation_id)
                      onOpenChange(false)
                    }}
                  >
                    {t('kubecode.teamOpenSession')}
                  </Button>
                  {assignee.role === 'teammate' && (
                    <Button
                      disabled={busyAction !== null}
                      variant="ghost"
                      onClick={() => setConfirmation('remove')}
                    >
                      <Trash2  size={16}/> {t('kubecode.teamRemoveMember')}
                    </Button>
                  )}
                </>
              )}
              {['failed', 'cancelled'].includes(task.status) && (
                <Button
                  disabled={busyAction !== null}
                  variant="outline"
                  onClick={() => void act(
                    `retry:${task.id}`,
                    () => api.retryTeamTask(snapshot.team.id, task.id),
                  )}
                >
                  <RefreshCw  size={16}/> {t('kubecode.teamTaskRetry')}
                </Button>
              )}
              {!['accepted', 'cancelled'].includes(task.status) && (
                <Button
                  disabled={busyAction !== null}
                  variant="outline"
                  onClick={() => setConfirmation('cancel')}
                >
                  {t('kubecode.teamTaskCancel')}
                </Button>
              )}
            </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(confirmation === 'remove'
                ? 'kubecode.teamRemoveMemberTitle'
                : 'kubecode.teamTaskCancelTitle')}
            </DialogTitle>
            <DialogDescription>
              {t(confirmation === 'remove'
                ? 'kubecode.teamRemoveMemberDescription'
                : 'kubecode.teamTaskCancelDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmation(null)}>
              {t('kubecode.cancel')}
            </Button>
            <Button
              variant={confirmation === 'remove' ? 'destructive' : 'default'}
              onClick={() => {
                if (!task) return
                const action = confirmation
                setConfirmation(null)
                if (action === 'remove' && assignee) {
                  void act(
                    `remove:${assignee.id}`,
                    () => api.removeTeamMember(snapshot.team.id, assignee.id),
                  )
                } else if (action === 'cancel') {
                  void act(
                    `cancel:${task.id}`,
                    () => api.cancelTeamTask(snapshot.team.id, task.id),
                  )
                }
              }}
            >
              {t(confirmation === 'remove'
                ? 'kubecode.teamRemoveMember'
                : 'kubecode.teamTaskCancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TaskCard({
  conversations,
  members,
  onSelectMember,
  onSelectTask,
  task,
}: {
  conversations: Map<string, TeamSnapshot['conversations'][number]>
  members: TeamMember[]
  onSelectMember: (conversationId: string) => void
  onSelectTask: (taskId: string) => void
  task: TeamTask
}) {
  const assignee = members.find((member) => member.id === task.assignee_member_id)
  const conversation = assignee ? conversations.get(assignee.conversation_id) : undefined
  return (
    <article
      className="kubecode-team-task-card"
      data-status={task.status}
      data-testid={`team-task-card-${task.id}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelectTask(task.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelectTask(task.id)
      }}
    >
      <strong>{task.title}</strong>
      <footer>
        {assignee && conversation ? (
          <Button
            aria-label={assignee.name}
            size="sm"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation()
              onSelectMember(assignee.conversation_id)
            }}
          >
            <AiAgentIcon agent={conversation.agent_id} size={14} />
            <span>{assignee.name}</span>
          </Button>
        ) : <span>—</span>}
      </footer>
    </article>
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
