import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { DestinationHeader } from '../app/DestinationHeader'

import type { TaskBoard, TaskDraft, TaskStage } from '../api'
import { usePlaceState, useScrollMemory } from '../app/location/placeMemory'
import { ReaderLoading } from '../resources/ReaderStates'
import { TaskCardView } from './TaskCardView'
import { TaskDisclosure } from './TaskDisclosure'
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
        className="-mx-(--ws-space-4)"
        actions={(
          <Field className="w-auto" orientation="horizontal">
            <Switch checked={needsYou} id={switchId} onCheckedChange={setNeedsYou} />
            <FieldLabel htmlFor={switchId}>{t('kubecode.task.needsYouOnly')}</FieldLabel>
          </Field>
        )}
        destination="board"
        t={t}
      />
      {status === 'error' && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{t('kubecode.task.loadFailed')}</span>
            <Button size="xs" variant="outline" onClick={onReload}>{t('kubecode.retry')}</Button>
          </AlertDescription>
        </Alert>
      )}
      {status === 'loading' && <ReaderLoading>{t('kubecode.task.loading')}</ReaderLoading>}
      {empty && (
        <Empty className="kubecode-task-empty">
          <EmptyHeader>
            <EmptyDescription>{t('kubecode.task.boardEmpty')}</EmptyDescription>
          </EmptyHeader>
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
          <TaskDisclosure>{t('kubecode.task.proposals', { count: drafts.length })}</TaskDisclosure>
          <CollapsibleContent>
            <ItemGroup className="gap-1">
              {drafts.map((draft) => (
                <BoardRow
                  current={selectedId === draft.id}
                  id={draft.id}
                  key={draft.id}
                  title={draft.title}
                  onOpen={onOpenTask}
                >
                  <Badge variant="secondary">{t('kubecode.task.revision', { revision: draft.revision })}</Badge>
                </BoardRow>
              ))}
            </ItemGroup>
          </CollapsibleContent>
        </Collapsible>
      )}
      {nothingNeedsYou && (
        <Empty className="kubecode-task-empty" role="status">
          <EmptyHeader>
            <EmptyDescription>{t('kubecode.task.nothingNeedsYou')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {board && !nothingNeedsYou && (
        <Tabs className="kubecode-task-stages" value={stage} onValueChange={(value) => setStage(value as TaskStage)}>
          <TabsList aria-label={t('kubecode.task.stagePicker')} className="kubecode-task-stage-tabs" variant="line">
            {TASK_STAGES.map((value) => (
              <TabsTrigger key={value} value={value}>
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
                    <h3 className="kubecode-task-column-heading flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      {stageLabel(t, value)}
                      <Badge variant="secondary">{column.length}</Badge>
                    </h3>
                    {column.length === 0 ? (
                      <Empty size="compact" variant="outline">
                        <EmptyHeader>
                          <EmptyDescription>{t('kubecode.task.columnEmpty')}</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <ul className="flex flex-col gap-2">
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
                    )}
                  </section>
                </TabsContent>
              )
            })}
          </div>
        </Tabs>
      )}
      {archived.length > 0 && (
        <Collapsible className="kubecode-task-archived">
          <TaskDisclosure>{t('kubecode.task.archivedList', { count: archived.length })}</TaskDisclosure>
          <CollapsibleContent>
            <ItemGroup className="gap-1">
              {archived.map((item) => {
                const outcome = outcomeLabel(t, item.outcome)
                return (
                  <BoardRow current={selectedId === item.id} id={item.id} key={item.id} title={item.title} onOpen={onOpenTask}>
                    <Badge variant="secondary">
                      {item.stage ? stageLabel(t, item.stage) : t('kubecode.task.archivedProposal')}
                    </Badge>
                    {outcome && <Badge variant="success">{outcome}</Badge>}
                  </BoardRow>
                )
              })}
            </ItemGroup>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  )
}

/** A proposal or an archived Task: one official Item that is itself the button opening it. */
function BoardRow({ children, current, id, onOpen, title }: {
  id: string
  title: string
  current: boolean
  onOpen: (id: string) => void
  children: ReactNode
}) {
  return (
    <Item asChild className="w-full text-left" size="sm" variant={current ? 'muted' : 'default'}>
      <button
        aria-current={current ? 'true' : undefined}
        data-focus-key={`card:${id}`}
        type="button"
        onClick={() => onOpen(id)}
      >
        <ItemContent>
          <ItemTitle className="[overflow-wrap:anywhere]">{title}</ItemTitle>
        </ItemContent>
        <ItemActions className="flex-wrap">{children}</ItemActions>
      </button>
    </Item>
  )
}
