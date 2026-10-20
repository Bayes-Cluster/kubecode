import { useEffect, useId, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { ViewHeader } from '@/components/workspace/ViewHeader'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { TaskBoard, TaskDraft, TaskStage } from '../api'
import { usePlaceState, useScrollMemory } from '../app/location/placeMemory'
import { TaskCardView } from './TaskCardView'
import { initialBoardStage, inspectedStage, requiredActionOf } from './taskLifecycle'
import { outcomeLabel, stageLabel, TASK_STAGES } from './taskLabels'
import type { TaskBoardStatus } from './useTaskBoard'

export type TaskBoardViewProps = {
  board: TaskBoard | null
  drafts: TaskDraft[]
  /** The Task open in the inspector (the bottom task entry of the board's stack), marked on its card. */
  selectedId?: string | null
  status: TaskBoardStatus
  t: Translator
  /** The app's language, for times. */
  locale?: string
  /** Opens a Task, a proposal, or an archived Task in the inspector. */
  onOpenTask: (id: string) => void
  onOpenGeneral: () => void
  onReload: () => void
  /** Where the board's place is kept (`placeKey.view`): scroll, the stage shown, the filter. */
  scrollKey?: string | null
}

/**
 * The Workspace's one board (ADR 0221, ADR 0230 §1): admitted, top-level Tasks
 * in Ready, In progress, Review, and Done. Waiting, blocked, paused, and
 * needs-input are conditions shown on a card, never columns. A card only
 * opens its Task: nothing here drags, admits, starts, or finishes one — that
 * is the General Agent's act on the researcher's words in General. Proposals
 * are listed above the stages, archived Tasks below them; a narrow board shows
 * one stage at a time.
 */
export function TaskBoardView({
  board,
  drafts,
  locale,
  onOpenGeneral,
  onOpenTask,
  onReload,
  scrollKey = null,
  selectedId = null,
  status,
  t,
}: TaskBoardViewProps) {
  const scroller = useRef<HTMLElement>(null)
  useScrollMemory(scroller, scrollKey, { ready: board !== null })
  const [needsYou, setNeedsYou] = usePlaceState(scrollKey ? `${scrollKey}#needsYou` : null, false)
  const [pickedStage, setStage] = usePlaceState<TaskStage | null>(scrollKey ? `${scrollKey}#stage` : null, null)
  const followed = inspectedStage(board, selectedId)
  // The stage shown on a narrow board follows the inspected Task, also when it
  // moves column; the researcher can still pick another stage afterwards.
  useEffect(() => {
    if (followed) setStage(followed)
  }, [followed, selectedId, setStage])
  const switchId = useId()

  // Closing a Task gives focus back to its card when nothing else took it
  // (the inspector was opened elsewhere, or its opener was replaced).
  const shownTask = useRef(selectedId)
  useEffect(() => {
    const previous = shownTask.current
    shownTask.current = selectedId
    if (!previous || selectedId) return
    const active = document.activeElement
    if (active && active !== document.body) return
    scroller.current?.querySelector<HTMLElement>(`[data-focus-key="card:${CSS.escape(previous)}"]`)?.focus({ preventScroll: true })
  }, [selectedId])

  const cards = (board?.cards ?? []).filter((card) => !needsYou || requiredActionOf(card) !== null)
  const stage = pickedStage ?? (board ? initialBoardStage(board) : 'ready')
  const archived = board?.archived ?? []
  const empty = board !== null && board.cards.length === 0 && drafts.length === 0

  return (
    <section aria-label={t('kubecode.nav.board')} className="kubecode-task-board" ref={scroller}>
      <ViewHeader
        actions={(
          <span className="kubecode-task-needs-you">
            <Switch aria-labelledby={switchId} checked={needsYou} onCheckedChange={setNeedsYou} />
            <span id={switchId}>{t('kubecode.task.needsYouOnly')}</span>
          </span>
        )}
        icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.board.Icon} />}
        level={2}
        title={t('kubecode.nav.board')}
      />
      {status === 'error' && (
        <p className="kubecode-research-error" role="alert">
          {t('kubecode.task.loadFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={onReload}>{t('kubecode.retry')}</Button>
        </p>
      )}
      {status === 'loading' && (
        <p className="kubecode-research-muted" role="status">{t('kubecode.task.loading')}</p>
      )}
      {empty && (
        <div className="kubecode-task-empty">
          <p>{t('kubecode.task.boardEmpty')}</p>
          <Button size="sm" variant="outline" onClick={onOpenGeneral}>
            <Icon role="command" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />
            {t('kubecode.task.goToGeneral')}
          </Button>
        </div>
      )}
      {drafts.length > 0 && (
        <details className="kubecode-task-drafts" open={board !== null && board.cards.length === 0 ? true : undefined}>
          <summary>{t('kubecode.task.proposals', { count: drafts.length })}</summary>
          <p className="kubecode-research-muted">{t('kubecode.task.proposalsHint')}</p>
          <ul>
            {drafts.map((draft) => (
              <li key={draft.id}>
                <button
                  aria-current={selectedId === draft.id ? 'true' : undefined}
                  className="kubecode-research-nav-item"
                  data-focus-key={`card:${draft.id}`}
                  type="button"
                  onClick={() => onOpenTask(draft.id)}
                >
                  <span className="kubecode-research-nav-title">{draft.title}</span>
                  <StatusBadge tone="muted">{t('kubecode.task.revision', { revision: draft.revision })}</StatusBadge>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {board && (
        <>
          <div aria-label={t('kubecode.task.stagePicker')} className="kubecode-task-stage-tabs" role="group">
            {TASK_STAGES.map((value) => (
              <button
                aria-pressed={stage === value}
                className="kubecode-task-stage-tab"
                key={value}
                type="button"
                onClick={() => setStage(value)}
              >
                {t('kubecode.task.stageTab', {
                  stage: stageLabel(t, value),
                  count: cards.filter((card) => card.stage === value).length,
                })}
              </button>
            ))}
          </div>
          <div className="kubecode-task-columns">
            {TASK_STAGES.map((value) => {
              const column = cards.filter((card) => card.stage === value)
              return (
                <section
                  aria-label={stageLabel(t, value)}
                  className="kubecode-task-column"
                  data-selected={stage === value}
                  data-stage={value}
                  key={value}
                >
                  <h3>
                    {stageLabel(t, value)}
                    <StatusBadge tone="muted">{column.length}</StatusBadge>
                  </h3>
                  {column.length === 0 && <p className="kubecode-research-muted">{t('kubecode.task.columnEmpty')}</p>}
                  <ul>
                    {column.map((card) => (
                      <li key={card.id}>
                        <TaskCardView
                          card={card}
                          locale={locale}
                          selected={selectedId === card.id}
                          t={t}
                          onOpen={() => onOpenTask(card.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        </>
      )}
      {archived.length > 0 && (
        <details className="kubecode-task-archived">
          <summary>{t('kubecode.task.archivedList', { count: archived.length })}</summary>
          <ul>
            {archived.map((item) => {
              const outcome = outcomeLabel(t, item.outcome)
              return (
                <li key={item.id}>
                  <button
                    aria-current={selectedId === item.id ? 'true' : undefined}
                    className="kubecode-research-nav-item"
                    data-focus-key={`card:${item.id}`}
                    type="button"
                    onClick={() => onOpenTask(item.id)}
                  >
                    <span className="kubecode-research-nav-title">{item.title}</span>
                    <StatusBadge tone="muted">
                      {item.stage ? stageLabel(t, item.stage) : t('kubecode.task.archivedProposal')}
                    </StatusBadge>
                    {outcome && <StatusBadge tone="ok">{outcome}</StatusBadge>}
                  </button>
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </section>
  )
}
