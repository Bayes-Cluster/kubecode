import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription } from '@/components/ui/empty'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { DestinationHeader } from '../app/DestinationHeader'

import type { TaskBoard, TaskDraft, TaskStage } from '../api'
import { usePlaceState, useScrollMemory } from '../app/location/placeMemory'
import { TaskCardView } from './TaskCardView'
import { StatusBadge } from '@/components/workspace/StatusBadge'
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
  // The stage shown on a narrow board follows the Task inspected last, also
  // when it moves column (even after it was closed, as a decision lands); the
  // researcher can still pick another stage afterwards.
  const [lastInspected, setLastInspected] = useState(selectedId)
  if (selectedId && selectedId !== lastInspected) setLastInspected(selectedId)
  const followedId = selectedId ?? lastInspected
  const stage = pickedStage ?? (board ? initialBoardStage(board) : 'ready')
  const followed = inspectedStage(board, followedId)
  useEffect(() => {
    if (followed) setStage(followed)
  }, [followed, followedId, setStage])
  const switchId = useId()

  // Closing a Task gives focus back to its card when nothing else took it
  // (the inspector was opened elsewhere, or its opener was replaced), and
  // keeps it there while the card moves column, until the researcher moves on.
  const shownTask = useRef(selectedId)
  const returning = useRef<string | null>(null)
  useEffect(() => {
    const previous = shownTask.current
    shownTask.current = selectedId
    if (selectedId) returning.current = null
    else if (previous) returning.current = previous
  }, [selectedId])
  useEffect(() => {
    const id = returning.current
    if (!id) return
    const cardOf = () => scroller.current?.querySelector<HTMLElement>(`[data-focus-key="card:${CSS.escape(id)}"]`) ?? null
    const active = document.activeElement
    const target = cardOf()
    if (active && active !== document.body && active !== target) {
      returning.current = null
      return
    }
    if (target && active !== target) target.focus({ preventScroll: true })
    const moveOn = () => { returning.current = null }
    document.addEventListener('pointerdown', moveOn, { once: true })
    document.addEventListener('keydown', moveOn, { once: true })
    return () => {
      document.removeEventListener('pointerdown', moveOn)
      document.removeEventListener('keydown', moveOn)
    }
  }, [board, selectedId, stage])

  const cards = (board?.cards ?? []).filter((card) => !needsYou || requiredActionOf(card) !== null)
  const archived = board?.archived ?? []
  const empty = board !== null && board.cards.length === 0 && drafts.length === 0
  // Filtered to what needs the researcher and nothing does: one sentence, not four empty columns.
  const nothingNeedsYou = needsYou && board !== null && board.cards.length > 0 && cards.length === 0

  return (
    <section aria-label={t('kubecode.nav.board')} className="kubecode-task-board" ref={scroller}>
      <DestinationHeader
        actions={(
          <span className="kubecode-task-needs-you">
            <Switch aria-labelledby={switchId} checked={needsYou} onCheckedChange={setNeedsYou} />
            <span id={switchId}>{t('kubecode.task.needsYouOnly')}</span>
          </span>
        )}
        destination="board"
        t={t}
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
        <Empty className="kubecode-task-empty">
          <EmptyDescription>{t('kubecode.task.boardEmpty')}</EmptyDescription>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={onOpenGeneral}>
              <Icon role="command" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />
              {t('kubecode.task.goToGeneral')}
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {drafts.length > 0 && (
        <Collapsible
          className="kubecode-task-drafts"
          defaultOpen={board !== null && board.cards.length === 0}
          key={board !== null && board.cards.length === 0 ? 'open' : 'closed'}
        >
          <CollapsibleTrigger className="kubecode-task-disclosure">
            <Icon className="kubecode-task-disclosure-chevron" role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.expand.Icon} />
            {t('kubecode.task.proposals', { count: drafts.length })}
          </CollapsibleTrigger>
          <CollapsibleContent asChild><ul>
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
                  <StatusBadge>{t('kubecode.task.revision', { revision: draft.revision })}</StatusBadge>
                </button>
              </li>
            ))}
          </ul></CollapsibleContent>
        </Collapsible>
      )}
      {nothingNeedsYou && (
        <p className="kubecode-task-empty kubecode-research-muted" role="status">{t('kubecode.task.nothingNeedsYou')}</p>
      )}
      {board && !nothingNeedsYou && (
        <>
          <Tabs className="kubecode-task-stages" value={stage} onValueChange={(value) => setStage(value as TaskStage)}>
            <TabsList aria-label={t('kubecode.task.stagePicker')} className="kubecode-task-stage-tabs" variant="line">
              {TASK_STAGES.map((value) => (
                <TabsTrigger className="kubecode-task-stage-tab" key={value} value={value}>
                  {t('kubecode.task.stageTab', {
                    stage: stageLabel(t, value),
                    count: cards.filter((card) => card.stage === value).length,
                  })}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="kubecode-task-columns">
              {TASK_STAGES.map((value) => {
                const column = cards.filter((card) => card.stage === value)
                return (
                  // Every column stays mounted: a wide board shows all four, a narrow one the picked stage.
                  <TabsContent asChild forceMount key={value} value={value}>
                    <section
                      // A column is named by its stage, not by its tab, and is no extra tab stop.
                      aria-label={stageLabel(t, value)}
                      aria-labelledby={undefined}
                      className="kubecode-task-column"
                      data-selected={stage === value}
                      data-stage={value}
                      role="region"
                      tabIndex={undefined}
                    >
                      <h3>
                        {stageLabel(t, value)}
                        <StatusBadge>{column.length}</StatusBadge>
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
                  </TabsContent>
                )
              })}
            </div>
          </Tabs>
        </>
      )}
      {archived.length > 0 && (
        <Collapsible className="kubecode-task-archived">
          <CollapsibleTrigger className="kubecode-task-disclosure">
            <Icon className="kubecode-task-disclosure-chevron" role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.expand.Icon} />
            {t('kubecode.task.archivedList', { count: archived.length })}
          </CollapsibleTrigger>
          <CollapsibleContent asChild><ul>
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
                    <StatusBadge>
                      {item.stage ? stageLabel(t, item.stage) : t('kubecode.task.archivedProposal')}
                    </StatusBadge>
                    {outcome && <StatusBadge tone="ok">{outcome}</StatusBadge>}
                  </button>
                </li>
              )
            })}
          </ul></CollapsibleContent>
        </Collapsible>
      )}
    </section>
  )
}
