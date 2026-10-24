import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Clock,
  GitBranch,
  ListChecks,
  RefreshCw,
  Trash2
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, TeamMember, TeamSnapshot, TeamTask, WorkBoardFilter, WorkspaceEvent } from '../api'
import { TEAM_TASK_STATUS_ICONS, type TeamTaskStatusState } from '../icons/statusIcons'
import { WorkBoard } from '../work/WorkBoard'
import { statusToneVariant, type StatusTone } from '../statusTone'

export function TeamTasksView({
  api,
  busyAction,
  events,
  onSelectMember,
  onSnapshotChange,
  setBusyAction,
  setError,
  snapshot,
  t,
}: {
  api: KubecodeApi
  busyAction: string | null
  events: WorkspaceEvent[]
  onSelectMember: (conversationId: string) => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  setBusyAction: (value: string | null) => void
  setError: (value: string | null) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'tasks' | 'activity' | 'dependencies'>('tasks')
  const tasks = useMemo(() => snapshot.tasks ?? [], [snapshot.tasks])
  const activity = useMemo(() => snapshot.activity ?? [], [snapshot.activity])
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null
  // The Team's board is the Workspace's one board under a Team scope; it
  // refetches when this snapshot changes.
  const [boardFilter, setBoardFilter] = useState<WorkBoardFilter>({})
  const refreshKey = useMemo(
    () => JSON.stringify([
      tasks.map((task) => [task.id, task.status, task.assignee_member_id]),
      (snapshot.task_attempts ?? []).length,
    ]),
    [tasks, snapshot.task_attempts],
  )

  return (
    <>
      <div className="kubecode-team-workspace-body" data-testid="team-workspace-body">
        <Tabs
          className="kubecode-team-detail-tabs"
          value={detailTab}
          onValueChange={(value) => setDetailTab(value as typeof detailTab)}
        >
          <TabsList className="max-w-full shrink-0 overflow-x-auto">
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
          <TabsContent className="min-h-0 overflow-auto" value="tasks">
            <WorkBoard
              api={api}
              connectionState="live"
              conversations={snapshot.conversations ?? []}
              embedded
              events={events}
              filter={boardFilter}
              projectId={snapshot.team.project_id}
              refreshKey={refreshKey}
              research={[]}
              scope={{ team_id: snapshot.team.id }}
              t={t}
              onFilterChange={setBoardFilter}
              onOpenCard={(card) => {
                // Team work is changed through its Team: open the Team's dialog.
                if (card.operable !== 'legacy_team') return false
                setSelectedTaskId(card.item.id)
                return true
              }}
              onOpenSession={onSelectMember}
            />
          </TabsContent>
          <TabsContent className="min-h-0 overflow-auto" value="activity">
            {activity.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyDescription>{t('kubecode.teamNoActivity')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="kubecode-team-activity-list gap-1">
                {activity.map((activityItem) => (
                  <Item data-kind={activityItem.kind} key={activityItem.id} role="listitem" size="sm">
                    <ItemContent>
                      <ItemTitle>{activityItem.summary}</ItemTitle>
                      <ItemDescription><time>{activityItem.created_at}</time></ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </TabsContent>
          <TabsContent className="min-h-0 overflow-auto" value="dependencies">
            <ItemGroup className="kubecode-team-dependency-list gap-1">
              {tasks.map((task) => (
                <Item key={task.id} role="listitem" size="sm" variant="outline">
                  <ItemContent>
                    <ItemTitle>{task.title}</ItemTitle>
                    {task.dependencies.length > 0
                      ? task.dependencies.map((dependency) => {
                        const parent = tasks.find((candidate) => candidate.id === dependency)
                        return (
                          <ItemDescription className="flex items-center gap-1" key={dependency}>
                            <ArrowRight aria-hidden="true" className="size-3.5 shrink-0" />
                            {parent?.title || dependency}
                          </ItemDescription>
                        )
                      })
                      : <ItemDescription>{t('kubecode.teamNoDependencies')}</ItemDescription>}
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
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
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              <ItemGroup className="gap-1">
                <Item size="sm" variant="muted">
                  <ItemContent><ItemDescription>{t('kubecode.teamTaskStatus')}</ItemDescription></ItemContent>
                  <ItemActions><TaskStatus status={task.status} t={t} /></ItemActions>
                </Item>
                <Item size="sm" variant="muted">
                  <ItemContent><ItemDescription>{t('kubecode.teamTaskAssignee')}</ItemDescription></ItemContent>
                  <ItemActions>{assignee?.name ?? t('kubecode.teamTaskUnassigned')}</ItemActions>
                </Item>
              </ItemGroup>
              {([
                ['kubecode.teamTaskDescription', task.description],
                ['kubecode.teamTaskResult', task.result],
                ['kubecode.teamTaskVerification', task.verification],
              ] as const).map(([label, text]) => text && (
                <section className="flex flex-col gap-1.5" key={label}>
                  <h3 className="text-sm font-medium">{t(label)}</h3>
                  <p className="select-text whitespace-pre-wrap break-words text-sm text-muted-foreground">{text}</p>
                </section>
              ))}
              {!task.assignee_member_id && task.status === 'pending' && teammates.length > 0 && (
                <Field>
                  <FieldLabel htmlFor="team-task-assign">{t('kubecode.teamTaskAssign')}</FieldLabel>
                  <Select
                    onValueChange={(memberId) => void act(
                      `assign:${task.id}`,
                      () => api.assignTeamTask(snapshot.team.id, task.id, memberId),
                    )}
                  >
                    <SelectTrigger aria-label={t('kubecode.teamTaskAssign')} id="team-task-assign">
                      <SelectValue placeholder={t('kubecode.teamTaskUnassigned')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {teammates.map((member) => (
                          <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            <DialogFooter className="flex-wrap">
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
                      <Trash2 data-icon="inline-start" /> {t('kubecode.teamRemoveMember')}
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
                  <RefreshCw data-icon="inline-start" /> {t('kubecode.teamTaskRetry')}
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
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(confirmation === 'remove'
                ? 'kubecode.teamRemoveMemberTitle'
                : 'kubecode.teamTaskCancelTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(confirmation === 'remove'
                ? 'kubecode.teamRemoveMemberDescription'
                : 'kubecode.teamTaskCancelDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('kubecode.cancel')}</AlertDialogCancel>
            <AlertDialogAction
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
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TaskStatus({ status, t }: { status: string; t: Translator }) {
  const entry = status in TEAM_TASK_STATUS_ICONS
    ? TEAM_TASK_STATUS_ICONS[status as TeamTaskStatusState]
    : null
  if (!entry) return <Badge variant="secondary">{status}</Badge>
  const StatusIcon = entry.Icon
  return (
    <Badge variant={statusToneVariant(TASK_TONES[status as TeamTaskStatusState] ?? 'muted')}>
      <StatusIcon aria-hidden="true" />
      {t(entry.labelKey)}
    </Badge>
  )
}

const TASK_TONES: Partial<Record<TeamTaskStatusState, StatusTone>> = {
  accepted: 'ok',
  blocked: 'warn',
  changes_requested: 'warn',
  done: 'ok',
  in_progress: 'info',
  plan_review: 'warn',
  result_review: 'warn',
}
