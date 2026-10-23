import { CircleAlert } from 'lucide-react'
import { useCallback, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { MoreActions, type MoreActionItem } from '@/components/workspace/MoreActions'
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
import { ReaderNotice } from '../resources/ReaderStates'
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
        <ReaderNotice action={<Button className="pointer-coarse:min-h-11" size="xs" variant="outline" onClick={reload}>{t('kubecode.retry')}</Button>} failed>
          {t('kubecode.task.loadFailed')}
        </ReaderNotice>
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
  const nextText = nextStepText(t, next, detail)
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
      actions={items.length > 0 ? <MoreActions items={items} label={t('kubecode.task.moreActions')} /> : undefined}
      icon={<TaskIcon />}
      meta={<TaskStatusBadges archived={archived} draft={draft} t={t} task={detail} />}
      title={title}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {/* What happens next, and where it is said: the header keeps only the Task's own facts (360px inspector). */}
        <Alert aria-label={t('kubecode.task.nextTitle')} className="kubecode-task-next-step" data-tone={next.tone} role="group">
          {next.tone === 'warn' && <CircleAlert aria-hidden />}
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {nextText && <span className="min-w-0 flex-1">{nextText}</span>}
            <Button size="sm" variant="outline" onClick={discuss}>
              <Icon role="command" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />
              {t('kubecode.task.discuss')}
            </Button>
          </AlertDescription>
        </Alert>
        {error && <ReaderNotice failed>{error}</ReaderNotice>}
        {/* An accepted (Done) Task has no work left to run, pause or stop (#229). */}
        {detail && !archived && detail.stage !== 'done' && <TaskWork detail={detail} projectId={projectId} onChanged={changed} />}
        {archived && (
          <DecisionButton busy={busy} variant="secondary" onDecide={() => void setArchived(false)}>
            {t('kubecode.task.restore')}
          </DecisionButton>
        )}
        {draft || !detail ? overview : (
          <Tabs className="min-w-0" value={tab} onValueChange={(value) => setTab(value as TaskTab)}>
            <TabsList aria-label={t('kubecode.task.tabs')} className="sticky top-0 z-[1] max-w-full overflow-x-auto bg-background" variant="line">
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
      {/* Archiving asks first, or says why it cannot happen now: the official AlertDialog (#259). */}
      <AlertDialog open={dialog !== null} onOpenChange={(open) => { if (!open && !busy) setDialog(null) }}>
        <AlertDialogContent>
          {dialog?.kind === 'blocked' ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('kubecode.task.archiveBlocked.title')}</AlertDialogTitle>
                <AlertDialogDescription>{blockedText(t, dialog.reason)}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('kubecode.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={discuss}>{t('kubecode.task.discuss')}</AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('kubecode.task.archiveConfirm.title', { title })}</AlertDialogTitle>
                <AlertDialogDescription>{t('kubecode.task.archiveConfirm.body')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>{t('kubecode.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  aria-busy={busy || undefined}
                  disabled={busy}
                  onClick={(event) => {
                    // The dialog stays until the server answers: it closes on success, or turns into why not.
                    event.preventDefault()
                    void setArchived(true)
                  }}
                >
                  {busy && <Spinner aria-hidden aria-label={undefined} data-icon="inline-start" role={undefined} />}
                  {t('kubecode.task.archiveConfirm.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
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

/** What happens next, or nothing while the specialists simply work (#229). */
function nextStepText(t: Translator, next: TaskNextStep, detail: TaskDetail | null): string | null {
  switch (next.kind) {
    case 'archived': return t('kubecode.task.next.archived')
    case 'draft': return t('kubecode.task.notOnBoard')
    case 'approval': return t('kubecode.task.next.approval', { revision: detail?.revision ?? '' })
    case 'review': return t('kubecode.task.next.review')
    case 'questions': return t('kubecode.task.next.questions')
    case 'returned': return t('kubecode.task.next.returned')
    case 'working': return null
    case 'ready': return t('kubecode.task.next.ready')
    case 'done': {
      const outcome = outcomeLabel(t, detail?.outcome)
      return outcome ? t('kubecode.task.next.done', { outcome }) : t('kubecode.task.next.doneNoOutcome')
    }
  }
}
