import { useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

        <div className="kubecode-work-filters" role="group" aria-label={t('kubecode.work.filters')}>
          {research.length > 0 && (
            <FilterSelect
              label={t('kubecode.work.field.research')}
              value={filter.research_id ?? ''}
              onChange={(value) => patch({ research_id: value || undefined, round_id: undefined })}
              options={research.map((item) => ({ value: item.id, label: item.title }))}
              allLabel={t('kubecode.work.filter.all')}
            />
          )}
          <FilterSelect
            label={t('kubecode.work.field.agent')}
            value={filter.conversation_id ?? ''}
            onChange={(value) => patch({ conversation_id: value || undefined })}
            options={sessions.map((item) => ({ value: item.id, label: item.title }))}
            allLabel={t('kubecode.work.filter.all')}
          />
          <FilterSelect
            label={t('kubecode.work.filter.source')}
            value={filter.origin ?? ''}
            onChange={(value) => patch({ origin: (value || undefined) as WorkBoardFilter['origin'] })}
            options={[
              { value: 'native', label: t('kubecode.work.filter.workspace') },
              { value: 'legacy_team', label: t('kubecode.work.legacy') },
            ]}
            allLabel={t('kubecode.work.filter.all')}
          />
          <Field className="w-auto" orientation="horizontal">
            <Checkbox
              checked={Boolean(filter.include_closed)}
              id="work-include-closed"
              onCheckedChange={(checked) => patch({ include_closed: checked === true })}
            />
            <FieldLabel variant="option" htmlFor="work-include-closed">
              {t('kubecode.work.filter.includeClosed')}
            </FieldLabel>
          </Field>
          {(effective.thread_id || effective.team_id || effective.round_id) && (
            <Badge variant="outline">{t('kubecode.work.filter.scoped')}</Badge>
          )}
          {!filterIsEmpty(filter) && (
            <Button size="xs" variant="ghost" onClick={() => onFilterChange({})}>
              {t('kubecode.work.filter.clear')}
            </Button>
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

        <div className="kubecode-work-columns">
          {WORK_STAGES.map((stage) => {
            const cards = byStage.get(stage) ?? []
            const count = board?.stages.find((entry) => entry.stage === stage)?.count ?? cards.length
            return (
              <section
                aria-label={t(STAGE_LABELS[stage])}
                className={cn('kubecode-work-column', dropTarget === stage && 'is-drop-target')}
                data-column={stage}
                data-empty={count === 0}
                data-testid={`work-column-${stage}`}
                key={stage}
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
                <header>
                  <h3 className="text-sm font-medium">{t(STAGE_LABELS[stage])}</h3>
                  <Badge className="tabular-nums" variant="secondary">{count}</Badge>
                </header>
                <div>
                  {cards.map((card) => (
                    <WorkCardView
                      card={card}
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
                </div>
              </section>
            )
          })}
        </div>

        {(closedCards.length > 0 || dragging) && (
          <section
            aria-label={t('kubecode.work.closedLane')}
            className={cn('kubecode-work-closed', dropTarget === 'closed' && 'is-drop-target')}
            data-testid="work-closed-lane"
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
            <header>
              <h3 className="text-sm font-medium">{t('kubecode.work.closedLane')}</h3>
              <Badge className="tabular-nums" variant="secondary">
                {board?.closed_truncated ? `${closedCards.length}+` : closedCards.length}
              </Badge>
            </header>
            <div>
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
            </div>
          </section>
        )}
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

const ALL = '__all__'

function FilterSelect({
  allLabel,
  label,
  onChange,
  options,
  value,
}: {
  allLabel: string
  label: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  value: string
}) {
  return (
    <Field className="kubecode-work-filter w-auto" orientation="horizontal">
      <FieldLabel className="shrink-0 text-muted-foreground" variant="option">{label}</FieldLabel>
      <Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? '' : next)}>
        <SelectTrigger aria-label={label} className="max-w-48" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={ALL}>{allLabel}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}
