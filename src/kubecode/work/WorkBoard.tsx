import { useMemo, useRef, useState } from 'react'

import {
  AgxBoard,
  AgxBoardColumn,
  AgxBoardColumns,
  AgxFilterChip,
  AgxFilterGroup,
  AgxFilterMenu,
  AgxFilterOption,
} from '@/components/agent-ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type {
  Conversation,
  KubecodeApi,
  ResearchSummary,
  WorkBoardFilter,
  WorkCard,
  WorkCondition,
  WorkStage,
  WorkspaceEvent,
} from '../api'
import { newClientMessageId } from '../session/sessionModel'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { ReaderEmpty, ReaderLoading, ReaderNotice } from '../resources/ReaderStates'
import { WorkCardView } from './WorkCardView'
import { type FormRequest, WorkInspector } from './WorkInspector'
import {
  ATTENTION_CONDITIONS,
  CONDITION_LABELS,
  filterIsEmpty,
  moveRequest,
  StartKeys,
  STAGE_LABELS,
  WORK_STAGES,
  workErrorMessage,
} from './workModel'
import { useWorkBoard } from './useWorkBoard'

export type WorkBoardProps = {
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  /** Sessions of every Project; this Project's standalone ones are offered. */
  conversations: Conversation[]
  events: WorkspaceEvent[]
  filter: WorkBoardFilter
  /** A scope the host fixes (a Team's work): always applied, never cleared. */
  scope?: WorkBoardFilter
  onFilterChange: (filter: WorkBoardFilter) => void
  /** Hosts with their own way to open a card (a Team's legacy dialog). */
  onOpenCard?: (card: WorkCard) => boolean | void
  onOpenResearch?: (researchId: string) => void
  onOpenSession?: (conversationId: string) => void
  onOpenTeam?: (teamId: string) => void
  onOpenThread?: (threadId: string) => void
  projectId: string
  refreshKey?: string
  research: ResearchSummary[]
  /** Inside another surface: no page header, and no back button. */
  embedded?: boolean
  onClose?: () => void
  t: Translator
}

/**
 * The Workspace's one Kanban. Research question, round, Thread, Team, and Agent
 * are filters over the same items — none creates another board or another card
 * — and the board is the server's projection, refetched on events. Dragging a
 * card expresses a supported command and never completes work by itself.
 */
export function WorkBoard({
  api,
  connectionState,
  conversations,
  embedded = false,
  events,
  filter,
  onClose,
  onFilterChange,
  onOpenCard,
  onOpenResearch,
  onOpenSession,
  onOpenTeam,
  onOpenThread,
  projectId,
  refreshKey,
  research,
  scope,
  t,
}: WorkBoardProps) {
  const effective = useMemo(() => ({ ...filter, ...scope }), [filter, scope])
  const { board, refreshFailed, reload, status } = useWorkBoard(
    api,
    projectId,
    effective,
    events,
    connectionState,
    refreshKey,
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formRequest, setFormRequest] = useState<FormRequest>({ form: null, nonce: 0 })
  const [dragging, setDragging] = useState<WorkCard | null>(null)
  const [dropTarget, setDropTarget] = useState<WorkStage | 'closed' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const startKeys = useRef(new StartKeys(newClientMessageId))
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const createKey = useRef(newClientMessageId())
  const sessions = useMemo(() => conversations.filter((item) => (
    item.project_id === projectId
    && !item.archived
    && !item.team_id
    && item.relationship !== 'team_member'
    && item.relationship !== 'subagent'
  )), [conversations, projectId])
  const byStage = useMemo(() => {
    const grouped = new Map<WorkStage, WorkCard[]>(WORK_STAGES.map((stage) => [stage, []]))
    for (const card of board?.cards ?? []) grouped.get(card.item.stage)?.push(card)
    return grouped
  }, [board])
  const conditionCount = (condition: WorkCondition) => (
    board?.conditions.find((entry) => entry.condition === condition)?.count ?? 0
  )
  const attention = ATTENTION_CONDITIONS.filter((condition) => conditionCount(condition) > 0)
  const patch = (next: Partial<WorkBoardFilter>) => {
    const merged: WorkBoardFilter = { ...filter, ...next }
    for (const key of Object.keys(merged) as Array<keyof WorkBoardFilter>) {
      if (merged[key] === undefined || merged[key] === '' || merged[key] === false) delete merged[key]
    }
    onFilterChange(merged)
  }

  const open = (card: WorkCard, nextForm: FormRequest['form'] = null) => {
    if (onOpenCard?.(card) === true) return
    setFormRequest((current) => ({ form: nextForm, nonce: current.nonce + 1 }))
    setSelectedId(card.item.id)
  }

  const drop = async (to: WorkStage | 'closed') => {
    const card = dragging
    setDragging(null)
    setDropTarget(null)
    if (!card) return
    const request = moveRequest(card, to, startKeys.current.keyFor(card))
    if (request.type === 'unsupported') {
      setNotice(t('kubecode.work.moveUnsupported'))
      return
    }
    setNotice(null)
    if (request.type === 'open') {
      open(card, request.form)
      return
    }
    try {
      await api.workCommand(projectId, card.item.id, card.item.state_revision, request.command)
      startKeys.current.done(card)
    } catch (cause) {
      setNotice(workErrorMessage(cause, t))
    }
    reload()
  }

  const createTask = async () => {
    const title = newTitle.trim()
    if (!title || creating) return
    setCreating(true)
    setNotice(null)
    try {
      const created = await api.createWork(projectId, {
        title,
        description: newDescription.trim(),
        roundId: effective.round_id,
        threadId: effective.thread_id,
        clientRequestId: createKey.current,
      })
      createKey.current = newClientMessageId()
      setNewTitle('')
      setNewDescription('')
      setAdding(false)
      reload()
      open(created)
    } catch (cause) {
      setNotice(workErrorMessage(cause, t))
    } finally {
      setCreating(false)
    }
  }

  const attentionTotal = attention.reduce((sum, condition) => sum + conditionCount(condition), 0)
  const closedCards = board?.closed ?? []
  // The filter menu's groups: folded unless they hold the active selection.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const groupOpen = (key: string, active: boolean) => openGroups[key] ?? active
  const toggleGroup = (key: string) => (open: boolean) => {
    setOpenGroups((current) => ({ ...current, [key]: open }))
  }
  const researchTitle = research.find((item) => item.id === filter.research_id)?.title
  const sessionTitle = sessions.find((item) => item.id === filter.conversation_id)?.title
  const sourceLabel = filter.origin === 'native'
    ? t('kubecode.work.filter.workspace')
    : filter.origin === 'legacy_team'
      ? t('kubecode.work.legacy')
      : null
  const conditionLabel = filter.condition && filter.condition !== 'none'
    ? t(CONDITION_LABELS[filter.condition as Exclude<WorkCondition, 'none'>])
    : null
  const filtersActive = !filterIsEmpty(filter)

  return (
    <section
      aria-label={t('kubecode.work.title')}
      className={cn('kubecode-work-board', embedded && 'is-embedded')}
    >
      <div className="kubecode-work-main">
        {!embedded && (
          <header className="kubecode-work-header">
            <div>
              {onClose && (
                <Button size="xs" variant="ghost" onClick={onClose}>{t('kubecode.work.back')}</Button>
              )}
              <h2>{t('kubecode.work.title')}</h2>
              <p className="kubecode-research-muted">{t('kubecode.work.subtitle')}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setAdding((value) => !value)}>
              {t('kubecode.work.newTask')}
            </Button>
          </header>
        )}
        {adding && !embedded && (
          <form
            className="kubecode-work-new"
            onSubmit={(event) => {
              event.preventDefault()
              void createTask()
            }}
          >
            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel htmlFor="work-new-title">{t('kubecode.research.field.title')}</FieldLabel>
                <Input
                  id="work-new-title"
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="work-new-objective">{t('kubecode.work.field.objective')}</FieldLabel>
                <Textarea id="work-new-objective" rows={2} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} />
              </Field>
            </FieldGroup>
            <div className="kubecode-work-command-row">
              <Button disabled={creating || newTitle.trim() === ''} size="sm" type="submit">
                {t('kubecode.work.createTask')}
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setAdding(false)}>
                {t('kubecode.cancel')}
              </Button>
            </div>
          </form>
        )}

        <div className="kubecode-work-filters">
          <AgxFilterMenu
            chips={(
              <>
                {researchTitle && <AgxFilterChip>{researchTitle}</AgxFilterChip>}
                {sessionTitle && <AgxFilterChip>{sessionTitle}</AgxFilterChip>}
                {sourceLabel && <AgxFilterChip>{sourceLabel}</AgxFilterChip>}
                {conditionLabel && <AgxFilterChip>{conditionLabel}</AgxFilterChip>}
                {filter.include_closed && <AgxFilterChip>{t('kubecode.work.filter.includeClosed')}</AgxFilterChip>}
              </>
            )}
            clearDisabled={!filtersActive}
            clearLabel={t('kubecode.work.filter.clear')}
            title={t('kubecode.work.filters')}
            onClear={filtersActive ? () => onFilterChange({}) : undefined}
          >
            {research.length > 0 && (
              <AgxFilterGroup
                count={research.length}
                label={t('kubecode.work.field.research')}
                open={groupOpen('research', Boolean(filter.research_id))}
                picked={researchTitle}
                onOpenChange={toggleGroup('research')}
              >
                {research.map((item) => (
                  <AgxFilterOption
                    checked={filter.research_id === item.id}
                    key={item.id}
                    label={item.title}
                    onToggle={() => patch({ research_id: filter.research_id === item.id ? undefined : item.id, round_id: undefined })}
                  />
                ))}
              </AgxFilterGroup>
            )}
            <AgxFilterGroup
              count={sessions.length}
              label={t('kubecode.work.field.agent')}
              open={groupOpen('agent', Boolean(filter.conversation_id))}
              picked={sessionTitle}
              onOpenChange={toggleGroup('agent')}
            >
              {sessions.map((item) => (
                <AgxFilterOption
                  checked={filter.conversation_id === item.id}
                  key={item.id}
                  label={item.title}
                  onToggle={() => patch({ conversation_id: filter.conversation_id === item.id ? undefined : item.id })}
                />
              ))}
            </AgxFilterGroup>
            <AgxFilterGroup
              count={2}
              label={t('kubecode.work.filter.source')}
              open={groupOpen('origin', Boolean(filter.origin))}
              picked={sourceLabel}
              onOpenChange={toggleGroup('origin')}
            >
              <AgxFilterOption
                checked={filter.origin === 'native'}
                label={t('kubecode.work.filter.workspace')}
                onToggle={() => patch({ origin: filter.origin === 'native' ? undefined : 'native' })}
              />
              <AgxFilterOption
                checked={filter.origin === 'legacy_team'}
                label={t('kubecode.work.legacy')}
                onToggle={() => patch({ origin: filter.origin === 'legacy_team' ? undefined : 'legacy_team' })}
              />
            </AgxFilterGroup>
            <AgxFilterGroup
              count={1}
              label={t('kubecode.work.closedLane')}
              open={groupOpen('closed', Boolean(filter.include_closed))}
              picked={filter.include_closed ? t('kubecode.work.filter.includeClosed') : undefined}
              onOpenChange={toggleGroup('closed')}
            >
              <AgxFilterOption
                checked={Boolean(filter.include_closed)}
                label={t('kubecode.work.filter.includeClosed')}
                onToggle={() => patch({ include_closed: filter.include_closed ? undefined : true })}
              />
            </AgxFilterGroup>
          </AgxFilterMenu>
          {(effective.thread_id || effective.team_id || effective.round_id) && (
            <Badge variant="outline">{t('kubecode.work.filter.scoped')}</Badge>
          )}
        </div>

        {attentionTotal > 0 && (
          <div className="kubecode-work-attention" role="status" aria-label={t('kubecode.work.attention')}>
            <ToggleGroup
              className="flex-wrap"
              size="sm"
              type="single"
              value={filter.condition ?? ''}
              variant="outline"
              onValueChange={(value) => patch({ condition: (value || undefined) as WorkCondition | undefined })}
            >
              {attention.map((condition) => (
                <ToggleGroupItem data-condition={condition} key={condition} value={condition}>
                  {t(CONDITION_LABELS[condition as Exclude<WorkCondition, 'none'>])} · {conditionCount(condition)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}

        {notice && <ReaderNotice failed>{notice}</ReaderNotice>}
        {status === 'loading' && <ReaderLoading>{t('kubecode.work.loading')}</ReaderLoading>}
        {status === 'error' && (
          <ReaderNotice action={<Button size="xs" variant="outline" onClick={reload}>{t('kubecode.retry')}</Button>} failed>
            {t('kubecode.work.loadFailed')}
          </ReaderNotice>
        )}
        {refreshFailed && (
          <ReaderNotice action={<Button size="xs" variant="outline" onClick={reload}>{t('kubecode.retry')}</Button>} failed>
            {t('kubecode.work.refreshFailed')}
          </ReaderNotice>
        )}
        {board?.truncated && (
          <ReaderNotice>{t('kubecode.work.truncated', { shown: board.cards.length, total: board.total })}</ReaderNotice>
        )}
        {status === 'ready' && board && board.total === 0 && closedCards.length === 0 && (
          <ReaderEmpty>{filterIsEmpty(filter) ? t('kubecode.work.empty') : t('kubecode.work.emptyFiltered')}</ReaderEmpty>
        )}

        <AgxBoard>
        <AgxBoardColumns data-testid="work-board-columns">
          {WORK_STAGES.map((stage) => {
            const cards = byStage.get(stage) ?? []
            const count = board?.stages.find((entry) => entry.stage === stage)?.count ?? cards.length
            return (
              <AgxBoardColumn
                aria-label={t(STAGE_LABELS[stage])}
                count={count}
                data-column={stage}
                data-testid={`work-column-${stage}`}
                key={stage}
                label={t(STAGE_LABELS[stage])}
                over={dropTarget === stage}
                onDragLeave={() => setDropTarget((current) => (current === stage ? null : current))}
                onDragOver={(event) => {
                  if (!dragging) return
                  event.preventDefault()
                  setDropTarget(stage)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  void drop(stage)
                }}
              >
                {cards.map((card) => (
                  <WorkCardView
                    card={card}
                    dragging={dragging?.item.id === card.item.id}
                    draggable={card.operable === 'native'}
                    key={card.item.id}
                    selected={selectedId === card.item.id}
                    t={t}
                    onDragEnd={() => {
                      setDragging(null)
                      setDropTarget(null)
                    }}
                    onDragStart={setDragging}
                    onSelect={(selected) => open(selected)}
                  />
                ))}
              </AgxBoardColumn>
            )
          })}
        </AgxBoardColumns>

        {(closedCards.length > 0 || dragging) && (
          <AgxBoardColumn
            aria-label={t('kubecode.work.closedLane')}
            count={board?.closed_truncated ? `${closedCards.length}+` : closedCards.length}
            data-testid="work-closed-lane"
            label={t('kubecode.work.closedLane')}
            over={dropTarget === 'closed'}
            onDragOver={(event) => {
              if (!dragging) return
              event.preventDefault()
              setDropTarget('closed')
            }}
            onDrop={(event) => {
              event.preventDefault()
              void drop('closed')
            }}
          >
            {closedCards.map((card) => (
              <WorkCardView
                card={card}
                draggable={false}
                key={card.item.id}
                selected={selectedId === card.item.id}
                t={t}
                onDragEnd={() => undefined}
                onDragStart={() => undefined}
                onSelect={(selected) => open(selected)}
              />
            ))}
          </AgxBoardColumn>
        )}
        </AgxBoard>
      </div>

      {selectedId && (
        <WorkInspector
          api={api}
          connectionState={connectionState}
          events={events}
          formRequest={formRequest}
          replacements={(board?.cards ?? [])
            .filter((candidate) => candidate.item.id !== selectedId && candidate.operable === 'native')
            .map((candidate) => ({ id: candidate.item.id, title: candidate.item.title }))}
          startKeys={startKeys.current}
          key={selectedId}
          projectId={projectId}
          refreshKey={refreshKey}
          sessions={sessions}
          t={t}
          workId={selectedId}
          onChanged={reload}
          onClose={() => {
            setSelectedId(null)
            setFormRequest((current) => ({ form: null, nonce: current.nonce + 1 }))
          }}
          onOpenResearch={onOpenResearch}
          onOpenSession={onOpenSession}
          onOpenTeam={onOpenTeam}
          onOpenThread={onOpenThread}
        />
      )}
    </section>
  )
}
