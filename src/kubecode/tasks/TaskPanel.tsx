import { useCallback, useState } from 'react'

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import { MoreActions, type MoreActionItem } from '@/components/workspace/MoreActions'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_DESTINATION_ICONS, WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { ApiError, type TaskAvailability, type TaskDetail } from '../api'
import { errorMessage } from '../app/errors'
import { useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import type { InspectorEntry } from '../app/location/inspector'
import { placeKey, usePlaceState } from '../app/location/placeMemory'
import { useResearchBundle } from '../research/useResearch'
import { TaskActivity } from './TaskActivity'
import { outcomeLabel } from './taskLabels'
import { defaultTabOf, nextStepOf, type TaskNextStep, type TaskTab } from './taskLifecycle'
import { useGeneralFromTask } from './taskNavigation'
import { TaskOverview } from './TaskOverview'
import { TaskResults } from './TaskResults'
import { TaskStatusBadges } from './TaskStatusBadges'
import { TaskWork } from './TaskWork'
import { useTaskDetail } from './useTaskDetail'

const RESULTS_PENDING = new Set(['review', 'evidence_changed', 'suggestion'])

type ArchiveDialog = { kind: 'confirm' } | { kind: 'blocked'; reason: TaskAvailability['reason'] } | null

/**
 * A Task in the inspector (ADR 0230 §3): one header of Task facts, what
 * happens next, and three sections — Overview, Results, Activity. It never
 * shows the research question's Open/Resolved, and nothing here admits,
 * starts, or finishes a Task: that is said in General, and a Task is finished
 * by accepting its results. Archiving is apart from that, and the server
 * decides whether it is allowed now.
 */
export function TaskPanel({ entry, projectId }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'task' }>>) {
  const services = useInspectorServices()
  const { api, connectionState, events, t } = services
  const general = useGeneralFromTask()
  const taskId = entry.id
  const { detail, reload, status } = useTaskDetail(api, projectId, taskId, events, connectionState)
  const draftCard = services.taskBoard?.drafts.find((draft) => draft.id === taskId) ?? null
  const archivedCard = services.taskBoard?.board?.archived?.find((card) => card.id === taskId) ?? null
  const draft = status === 'draft'

  const memory = placeKey.task(projectId, taskId)
  const [chosenTab, setTab] = usePlaceState<TaskTab | null>(`${memory}#tab`, null)
  // The section a Task opens on is decided once per opening, so a decision
  // that closes the review does not move the researcher away from its result.
  const [openedOn, setOpenedOn] = useState<TaskTab | null>(null)
  if (openedOn === null && status === 'ready') setOpenedOn(defaultTabOf(detail))
  const tab = chosenTab ?? openedOn ?? defaultTabOf(detail)
  const [editing, setEditing] = useState(false)
  // The research record is read only once something needs it: a section that
  // shows findings or records, the brief editor, or a proposal's brief.
  const [wanted, setWanted] = useState(false)
  // Activity reads General only once it was shown, and stays mounted after.
  const [activitySeen, setActivitySeen] = useState(false)
  if (tab === 'activity' && status === 'ready' && !activitySeen) setActivitySeen(true)
  const needBundle = wanted || draft || editing || (status === 'ready' && tab !== 'overview')
  const research = useResearchBundle(api, projectId, needBundle ? taskId : null, events, connectionState)
  const bundle = research.bundle

  const [dialog, setDialog] = useState<ArchiveDialog>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const boardReload = services.taskBoard?.reload
  const changed = useCallback(() => {
    reload()
    boardReload?.()
  }, [boardReload, reload])

  const openRequest = detail?.review_requests.find((request) => request.state === 'open') ?? null
  const discuss = () => general(
    { filter: taskId, message: openRequest?.general_message_id ?? null },
    'composer:general',
  )

  const archived = detail ? Boolean(detail.archived) : archivedCard !== null
  const setArchived = async (archive: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await (archive ? api.archiveTask(projectId, taskId) : api.restoreTask(projectId, taskId))
      setDialog(null)
      changed()
      if (needBundle) research.reload()
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'task_active') {
        setDialog({ kind: 'blocked', reason: (cause.reason as TaskAvailability['reason']) ?? null })
      } else {
        setDialog(null)
        setError(errorMessage(cause, t('kubecode.error')))
      }
    } finally {
      setBusy(false)
    }
  }
  const askArchive = () => {
    const availability = detail?.actions?.archive
    setDialog(!availability || availability.allowed ? { kind: 'confirm' } : { kind: 'blocked', reason: availability.reason })
  }

  if (status === 'loading') {
    return <InspectorPanel icon={<TaskIcon />} status="loading" title={t('kubecode.nav.taskDetail')} />
  }
  if (status === 'error') {
    return (
      <InspectorPanel icon={<TaskIcon />} title={t('kubecode.nav.taskDetail')}>
        <p className="kubecode-research-error" role="alert">
          {t('kubecode.task.loadFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={reload}>{t('kubecode.retry')}</Button>
        </p>
      </InspectorPanel>
    )
  }

  const title = detail?.title ?? draftCard?.title ?? archivedCard?.title ?? bundle?.detail.brief.title
    ?? t('kubecode.nav.taskDetail')
  const shownMessage = draftCard?.shown_message_id ?? null
  // An archived Task is restored from its panel's own button, offered once.
  const items: MoreActionItem[] = [
    ...(archived ? [] : [{
      id: 'archive',
      label: draft ? t('kubecode.task.archiveProposal') : t('kubecode.task.archive'),
      onSelect: askArchive,
    }]),
    ...(draft && shownMessage ? [{
      id: 'proposal',
      label: t('kubecode.task.showProposal'),
      onSelect: () => general({ message: shownMessage }),
    }] : []),
  ]

  const next = archived && !detail ? { kind: 'archived' as const, tone: 'muted' as const } : nextStepOf(detail, draft)
  const overview = (
    <TaskOverview
      bundle={bundle}
      detail={detail}
      editing={editing}
      projectId={projectId}
      onBundleChanged={research.reload}
      onChanged={changed}
      onDiscuss={discuss}
      onEdit={() => {
        setWanted(true)
        setEditing(true)
      }}
      onEditDone={() => setEditing(false)}
      onOpenResults={() => setTab('results')}
    />
  )
  // Everything decided in Results: the review, changed evidence, and suggested changes of direction.
  const reviewCount = detail?.pending?.filter((item) => RESULTS_PENDING.has(item.kind)).length ?? 0

  return (
    <InspectorPanel
      actions={(
        <>
          <Button size="sm" variant="outline" onClick={discuss}>
            <Icon role="command" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />
            {t('kubecode.task.discuss')}
          </Button>
          {items.length > 0 && <MoreActions items={items} label={t('kubecode.task.moreActions')} />}
        </>
      )}
      icon={<TaskIcon />}
      meta={<TaskStatusBadges archived={archived} draft={draft} t={t} task={detail} />}
      title={title}
    >
      <div className="kubecode-task-panel">
        <p className="kubecode-task-next" data-tone={next.tone}>{nextStepText(t, next, detail)}</p>
        {error && <p className="kubecode-research-error" role="alert">{error}</p>}
        {detail && !archived && <TaskWork detail={detail} projectId={projectId} onChanged={changed} />}
        {archived && (
          <DecisionButton busy={busy} variant="secondary" onDecide={() => void setArchived(false)}>
            {t('kubecode.task.restore')}
          </DecisionButton>
        )}
        {draft || !detail ? overview : (
          <Tabs className="kubecode-task-tabs" value={tab} onValueChange={(value) => setTab(value as TaskTab)}>
            <TabsList aria-label={t('kubecode.task.tabs')} variant="line">
              <TabsTrigger value="overview">{t('kubecode.task.tab.overview')}</TabsTrigger>
              <TabsTrigger value="results">
                {t('kubecode.task.tab.results')}
                {reviewCount > 0 && <StatusBadge tone="info">{reviewCount}</StatusBadge>}
              </TabsTrigger>
              <TabsTrigger value="activity">{t('kubecode.task.tab.activity')}</TabsTrigger>
            </TabsList>
            <TabsContent forceMount hidden={tab !== 'overview'} value="overview">{overview}</TabsContent>
            <TabsContent forceMount hidden={tab !== 'results'} value="results">
              <TaskResults bundle={bundle} detail={detail} projectId={projectId} onBundleChanged={research.reload} onChanged={changed} />
            </TabsContent>
            <TabsContent forceMount hidden={tab !== 'activity'} value="activity">
              {activitySeen && (
                <TaskActivity bundle={bundle} detail={detail} projectId={projectId} onBundleChanged={research.reload} />
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <DialogContent>
          {dialog?.kind === 'blocked' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('kubecode.task.archiveBlocked.title')}</DialogTitle>
                <DialogDescription>{blockedText(t, dialog.reason)}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild><Button variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
                <Button onClick={() => { setDialog(null); discuss() }}>{t('kubecode.task.discuss')}</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('kubecode.task.archiveConfirm.title', { title })}</DialogTitle>
                <DialogDescription>{t('kubecode.task.archiveConfirm.body')}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild><Button variant="ghost">{t('kubecode.cancel')}</Button></DialogClose>
                <Button aria-busy={busy || undefined} disabled={busy} onClick={() => void setArchived(true)}>
                  {t('kubecode.task.archiveConfirm.confirm')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </InspectorPanel>
  )
}

function TaskIcon() {
  return <Icon role="navigation" source={WORKSPACE_OBJECT_ICONS.task.Icon} />
}

function blockedText(t: Translator, reason: TaskAvailability['reason']): string {
  switch (reason) {
    case 'work_active': return t('kubecode.task.archiveBlocked.work_active')
    case 'archived': return t('kubecode.task.archiveBlocked.archived')
    default: return t('kubecode.task.archiveBlocked.under_review')
  }
}

function nextStepText(t: Translator, next: TaskNextStep, detail: TaskDetail | null): string {
  switch (next.kind) {
    case 'archived': return t('kubecode.task.next.archived')
    case 'draft': return t('kubecode.task.notOnBoard')
    case 'approval': return t('kubecode.task.next.approval', { revision: detail?.revision ?? '' })
    case 'review': return t('kubecode.task.next.review')
    case 'questions': return t('kubecode.task.next.questions')
    case 'returned': return t('kubecode.task.next.returned')
    case 'working': return t('kubecode.task.next.working')
    case 'ready': return t('kubecode.task.next.ready')
    case 'done': {
      const outcome = outcomeLabel(t, detail?.outcome)
      return outcome ? t('kubecode.task.next.done', { outcome }) : t('kubecode.task.next.doneNoOutcome')
    }
  }
}
