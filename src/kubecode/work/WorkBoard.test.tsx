import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  Conversation, ResearchSummary, WorkBoardFilter, WorkCard, WorkspaceEvent,
} from '../api'
import { ApiError } from '../api'
import { WorkBoard } from './WorkBoard'
import { moveRequest, StartKeys } from './workModel'
import { boardOf, detailOf, workApi, workCard } from './workFixtures'
import { fileDocument } from '../tasks/taskFixtures'

/** Picks an option on an official Select (a Radix combobox, rendered in a portal). */
async function choose(scope: HTMLElement, name: string, option: string) {
  const trigger = within(scope).getByRole('combobox', { name })
  expect(trigger).toHaveAttribute('data-slot', 'select-trigger')
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const research: ResearchSummary[] = [{
  id: 'r1', project_id: 'p1', title: 'Pruning', status: 'open', archived: false,
  revision: 1, entry_count: 0, link_count: 0, updated_at: '',
}]
const sessions = [
  { id: 's1', project_id: 'p1', title: 'Pruner', archived: false, team_id: null, relationship: null },
  { id: 's2', project_id: 'p1', title: 'Analyst', archived: false, team_id: null, relationship: null },
] as unknown as Conversation[]

const executor = { session_id: 's1', title: 'Pruner', agent_id: 'opencode' as const, available: true }
const assignment = {
  id: 'a1', task_id: 'w1', conversation_id: 's1', member_id: null, assigned_by: null,
  started_at: '', ended_at: null, end_reason: null,
}

function view(
  api: ReturnType<typeof workApi>,
  props: {
    filter?: WorkBoardFilter
    events?: WorkspaceEvent[]
    connection?: 'live' | 'reconnecting'
    onFilterChange?: (filter: WorkBoardFilter) => void
  } = {},
) {
  const ui = (events: WorkspaceEvent[], connection: 'live' | 'reconnecting', filter: WorkBoardFilter) => (
    <WorkBoard
      api={api}
      connectionState={connection}
      conversations={sessions}
      events={events}
      filter={filter}
      projectId="p1"
      research={research}
      t={t}
      onFilterChange={props.onFilterChange ?? vi.fn()}
    />
  )
  const result = render(ui(props.events ?? [], props.connection ?? 'live', props.filter ?? {}))
  return {
    ...result,
    update: (
      events: WorkspaceEvent[],
      connection: 'live' | 'reconnecting' = 'live',
      filter: WorkBoardFilter = props.filter ?? {},
    ) => result.rerender(ui(events, connection, filter)),
  }
}

const workEvent = (id: number, project = 'p1'): WorkspaceEvent => ({
  id, kind: 'work_updated', project_id: project, conversation_id: null, run_id: null,
  payload: { change: 'stage' }, created_at: '',
})

describe('moveRequest', () => {
  it('turns a drop into a supported command and never into completion', () => {
    const ready = workCard({ stage: 'ready' }, { assignment })
    expect(moveRequest(ready, 'executing', 'k')).toEqual({
      type: 'run', command: { command: 'start', request_key: 'k' },
    })
    expect(moveRequest(workCard({ stage: 'ready' }), 'executing', 'k')).toEqual({ type: 'open', form: 'assign' })
    const review = workCard({ stage: 'review' })
    expect(moveRequest(review, 'done', 'k')).toEqual({ type: 'open', form: 'accept' })
    expect(moveRequest(review, 'executing', 'k')).toEqual({ type: 'open', form: 'reject' })
    expect(moveRequest(ready, 'closed', 'k')).toEqual({ type: 'open', form: 'close' })
    // Nothing else is a command: readiness and completion are the server's.
    for (const target of ['planned', 'ready', 'analyzing', 'review', 'done'] as const) {
      expect(moveRequest(ready, target, 'k')).toEqual({ type: 'unsupported' })
    }
    expect(moveRequest(workCard({ stage: 'planned' }), 'done', 'k')).toEqual({ type: 'unsupported' })
    // Legacy and closed work are not moved from here.
    expect(moveRequest(workCard({ stage: 'ready' }, { operable: 'legacy_team' }), 'executing', 'k'))
      .toEqual({ type: 'unsupported' })
    expect(moveRequest(workCard({ stage: 'ready', lifecycle: 'canceled' }), 'executing', 'k'))
      .toEqual({ type: 'unsupported' })
  })
})

describe('WorkBoard', () => {
  it('shows the six stages with counts and keeps failure, negative results, and acceptance apart', async () => {
    const cards = [
      workCard({ id: 'plan', title: 'Plan it', stage: 'planned' }),
      workCard({ id: 'run', title: 'Run it', stage: 'executing' }, {
        executor, assignment, attempt_count: 3, experiment_count: 2,
        latest_attempt: { id: 'at', task_id: 'run', assignment_id: null, conversation_id: 's1', run_id: null,
          status: 'failed', failure_kind: null, error: 'OOM', created_at: '', updated_at: '', completed_at: null },
      }),
      workCard({ id: 'neg', title: 'Negative', stage: 'done', acceptance: 'accepted', outcome: 'refuted' }),
      workCard({ id: 'wait', title: 'Waiting one', stage: 'executing', condition: 'waiting',
        condition_reason: 'an experiment is running' }),
      workCard({ id: 'need', title: 'Needs you', stage: 'review', condition: 'needs_input' }),
      workCard({ id: 'legacy', title: 'Old task', stage: 'ready', origin: 'legacy_team' },
        { operable: 'legacy_team' }),
    ]
    view(workApi({ workBoard: vi.fn().mockResolvedValue(boardOf(cards)) }))
    await screen.findByText('Plan it')
    expect(screen.getAllByTestId(/^work-column-/)).toHaveLength(6)
    expect(within(screen.getByTestId('work-column-executing')).getByText('2', { selector: '[data-slot="badge"]' })).toBeInTheDocument()

    const run = screen.getByTestId('work-card-run')
    // The official Card is the frame; one native button inside opens the item (like TaskCardView).
    expect(run.tagName).toBe('BUTTON')
    expect(run.parentElement).toHaveAttribute('data-slot', 'card')
    expect(within(run).getByText('kubecode.work.attemptFailed')).toBeInTheDocument()
    expect(run).toHaveTextContent('3')
    expect(run).toHaveTextContent('Pruner')
    const negative = screen.getByTestId('work-card-neg')
    expect(within(negative).getByText('kubecode.work.outcome.refuted')).toBeInTheDocument()
    expect(within(negative).getByText('kubecode.work.acceptance.accepted')).toBeInTheDocument()
    expect(within(negative).queryByText('kubecode.work.attemptFailed')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('work-card-wait')).getByText('kubecode.work.condition.waiting')).toBeInTheDocument()
    expect(within(screen.getByTestId('work-card-need')).getByText('kubecode.work.condition.needsInput')).toBeInTheDocument()
    expect(within(screen.getByTestId('work-card-legacy')).getByText('kubecode.work.legacy')).toBeInTheDocument()
    expect(screen.getByTestId('work-card-legacy')).toHaveAttribute('draggable', 'false')
    expect(screen.getByTestId('work-card-plan')).toHaveAttribute('draggable', 'true')
    // Waits, blockers, pauses, and human-input needs are summarized apart from stages.
    const attention = screen.getByRole('status', { name: 'kubecode.work.attention' })
    expect(within(attention).getByText(/kubecode.work.condition.needsInput · 1/)).toBeInTheDocument()
    expect(within(attention).getByText(/kubecode.work.condition.waiting · 1/)).toBeInTheDocument()
  })

  it('narrows the same board with filters and chips, and clears them', async () => {
    const workBoard = vi.fn().mockResolvedValue(boardOf([
      workCard({ id: 'w1', title: 'One', condition: 'waiting' }),
    ]))
    const onFilterChange = vi.fn()
    const v = view(workApi({ workBoard }), { onFilterChange })
    await screen.findByText('One')
    expect(workBoard).toHaveBeenLastCalledWith('p1', {})
    const researchFilter = screen.getByRole('combobox', { name: 'kubecode.work.field.research' })
    expect(researchFilter).toHaveAttribute('data-slot', 'select-trigger')
    fireEvent.click(researchFilter)
    fireEvent.click(await screen.findByRole('option', { name: 'Pruning' }))
    expect(onFilterChange).toHaveBeenLastCalledWith({ research_id: 'r1' })
    fireEvent.click(screen.getByRole('combobox', { name: 'kubecode.work.field.agent' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Analyst' }))
    expect(onFilterChange).toHaveBeenLastCalledWith({ conversation_id: 's2' })
    const waiting = within(screen.getByRole('status', { name: 'kubecode.work.attention' })).getByRole('radio', { name: /kubecode.work.condition.waiting/ })
    expect(waiting).toHaveAttribute('data-slot', 'toggle-group-item')
    fireEvent.click(waiting)
    expect(onFilterChange).toHaveBeenLastCalledWith({ condition: 'waiting' })
    const includeClosed = screen.getByRole('checkbox', { name: 'kubecode.work.filter.includeClosed' })
    expect(includeClosed).toHaveAttribute('data-slot', 'checkbox')
    fireEvent.click(includeClosed)
    expect(onFilterChange).toHaveBeenLastCalledWith({ include_closed: true })

    // The host applies a filter: the board asks for exactly that, and can be cleared.
    v.update([], 'live', { research_id: 'r1', thread_id: 't1' })
    await waitFor(() => expect(workBoard).toHaveBeenLastCalledWith('p1', { research_id: 'r1', thread_id: 't1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.work.filter.clear' }))
    expect(onFilterChange).toHaveBeenLastCalledWith({})
  })

  it('lists canceled, abandoned, and superseded work with the reason in its own lane', async () => {
    const closed = workCard({ id: 'gone', title: 'Dropped idea', lifecycle: 'canceled', closed_reason: 'superseded by plan B' })
    const workBoard = vi.fn().mockResolvedValue(boardOf([workCard({ id: 'w1', title: 'Live' })], [closed]))
    view(workApi({ workBoard }), { filter: { include_closed: true } })
    const lane = await screen.findByTestId('work-closed-lane')
    expect(within(lane).getByText('Dropped idea')).toBeInTheDocument()
    expect(within(lane).getByText('kubecode.work.lifecycle.canceled')).toBeInTheDocument()
    expect(workBoard).toHaveBeenCalledWith('p1', { include_closed: true })
  })

  it('converges on work events of its Project and after a reconnect, and says when it is truncated', async () => {
    const workBoard = vi.fn().mockResolvedValue({ ...boardOf([workCard({ id: 'w1', title: 'One' })]), truncated: true, total: 450 })
    const v = view(workApi({ workBoard }))
    expect(await screen.findByText(/kubecode.work.truncated/)).toHaveTextContent('450')
    const initial = workBoard.mock.calls.length
    await act(async () => v.update([workEvent(1, 'other')]))
    expect(workBoard.mock.calls.length).toBe(initial)
    workBoard.mockResolvedValue(boardOf([workCard({ id: 'w1', title: 'One' }), workCard({ id: 'w2', title: 'Two' })]))
    await act(async () => v.update([workEvent(1, 'other'), workEvent(2)]))
    expect(await screen.findByText('Two')).toBeInTheDocument()
    await act(async () => v.update([workEvent(2)], 'reconnecting'))
    await act(async () => v.update([workEvent(2)], 'live'))
    await waitFor(() => expect(workBoard.mock.calls.length).toBeGreaterThan(initial + 1))
  })

  it('reports a failed load with a retry and an empty board plainly', async () => {
    const workBoard = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(boardOf([]))
    view(workApi({ workBoard }))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.retry' }))
    expect(await screen.findByText('kubecode.work.empty')).toBeInTheDocument()
  })

  it('opens one card in an inspector with its attempts, evidence, reviews, and deliveries', async () => {
    const card = workCard({ id: 'w1', title: 'Sweep ratios', stage: 'review', plan: '1. sweep', result: '30% is best' },
      { executor, assignment, origin_thread: { id: 't1', title: 'Pruning heads?' } })
    const detail = detailOf(card, {
      attempts: [{ id: 'a1', task_id: 'w1', assignment_id: null, conversation_id: 's1', run_id: 'run', status: 'completed',
        failure_kind: null, error: null, created_at: '2026-10-18 10:00', updated_at: '', completed_at: null }],
      results: [{ id: 'x', task_id: 'w1', attempt_id: null, role: 'evidence', kind: 'file', ref_id: 'results.csv', revision: null, created_at: '' }],
      reviews: [{ id: 'rv', task_id: 'w1', kind: 'result', accepted: false, outcome: 'unknown', reviewer: 'researcher',
        reason: 'needs a rerun', inputs: ['attempt:a1:completed'], created_at: '' }],
      routes: [{ id: 'ro', kind: 'dispatch', state: 'delivered', attempts: 0, last_error: null, created_at: '', delivered_at: null }],
      experiments: [{ id: 'e1', label: 'baseline', state: 'exited', analysis: 'pending', exit_code: 0, created_at: '' }],
    })
    const onOpenThread = vi.fn()
    const workBoardFn = vi.fn().mockResolvedValue(boardOf([card]))
    render(
      <WorkBoard
        api={workApi({ workBoard: workBoardFn, workDetail: vi.fn().mockResolvedValue(detail) })}
        connectionState="live"
        conversations={sessions}
        events={[]}
        filter={{}}
        projectId="p1"
        research={research}
        t={t}
        onFilterChange={vi.fn()}
        onOpenThread={onOpenThread}
      />,
    )
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    await within(inspector).findByText('30% is best')
    expect(inspector).toHaveTextContent('1. sweep')
    expect(inspector).toHaveTextContent('results.csv')
    expect(inspector).toHaveTextContent('needs a rerun')
    expect(inspector).toHaveTextContent('baseline')
    expect(inspector).toHaveTextContent('kubecode.work.analysisPending')
    expect(inspector).toHaveTextContent('kubecode.work.routeState.delivered')
    // Each history is a named group of official Items, not a raw list (#263).
    const attempts = within(inspector).getByRole('region', { name: 'kubecode.work.field.attempts' })
    expect(within(attempts).getByRole('list')).toHaveAttribute('data-slot', 'item-group')
    expect(within(attempts).getByRole('listitem')).toHaveAttribute('data-slot', 'item')
    fireEvent.click(within(inspector).getByRole('button', { name: 'Pruning heads?' }))
    expect(onOpenThread).toHaveBeenCalledWith('t1')
  })
})

describe('WorkBoard commands', () => {
  function setup(card: WorkCard, commandImpl = vi.fn().mockResolvedValue(card), extra: object = {}) {
    const workBoard = vi.fn().mockResolvedValue(boardOf([card]))
    const workDetail = vi.fn().mockResolvedValue(detailOf(card))
    const workCommand = commandImpl
    view(workApi({ workBoard, workDetail, workCommand, ...extra }))
    return { workBoard, workDetail, workCommand }
  }

  it('starts an attempt with the card revision and reuses one key across a failed try', async () => {
    const card = workCard({ id: 'w1', stage: 'ready', state_revision: 7 }, { executor, assignment })
    const workCommand = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(card)
    setup(card, workCommand)
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const start = await screen.findByRole('button', { name: 'kubecode.work.command.start' })
    fireEvent.click(start)
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.work.command.start' }))
    await waitFor(() => expect(workCommand).toHaveBeenCalledTimes(2))
    expect(workCommand.mock.calls[0][2]).toBe(7)
    expect(workCommand.mock.calls[0][3]).toEqual(workCommand.mock.calls[1][3])
    expect(workCommand.mock.calls[0][3]).toMatchObject({ command: 'start' })
  })

  it('reloads and says so when the card changed under the command', async () => {
    const card = workCard({ id: 'w1', stage: 'ready' }, { executor, assignment })
    const workCommand = vi.fn().mockRejectedValue(new ApiError('work_state_conflict', 'moved', 409))
    const { workDetail } = setup(card, workCommand)
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const initial = workDetail.mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.work.command.start' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.work.error.stale')
    await waitFor(() => expect(workDetail.mock.calls.length).toBeGreaterThan(initial))
  })

  it('names the limit when the researcher is refused by a round budget', async () => {
    const card = workCard({ id: 'w1', stage: 'ready' }, { executor, assignment })
    const workCommand = vi.fn().mockRejectedValue(new ApiError('work_budget_exhausted', 'x', 409))
    setup(card, workCommand)
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.work.command.start' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.work.error.budget')
  })

  it('accepts a result with the outcome the researcher judged, and a valid negative can complete it', async () => {
    const card = workCard({ id: 'w1', stage: 'review', state_revision: 4 }, { executor, assignment })
    const { workCommand } = setup(card)
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    await within(inspector).findByRole('combobox', { name: 'kubecode.work.review.outcome' })
    await choose(inspector, 'kubecode.work.review.outcome', 'kubecode.work.outcome.refuted')
    fireEvent.change(within(inspector).getByRole('textbox', { name: 'kubecode.work.review.reason' }), { target: { value: 'clean ablation' } })
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.command.accept' }))
    await waitFor(() => expect(workCommand).toHaveBeenCalledWith('p1', 'w1', 4, {
      command: 'review', accept: true, outcome: 'refuted', reason: 'clean ablation',
    }))
  })

  it('needs a reason to cancel and sends the plan revision', async () => {
    const card = workCard({ id: 'w1', stage: 'ready', revision: 5, state_revision: 9 })
    const { workCommand } = setup(card)
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.work.command.cancel' }))
    const cancel = screen.getByRole('button', { name: 'kubecode.work.lifecycle.canceled' })
    expect(cancel).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'kubecode.work.review.reason' }), { target: { value: 'not needed' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.work.lifecycle.canceled' }))
    await waitFor(() => expect(workCommand).toHaveBeenCalledWith('p1', 'w1', 9, {
      command: 'close', lifecycle: 'canceled', reason: 'not needed', expected_revision: 5,
    }))
  })

  it('offers no commands for a Team-owned task and points to its Team', async () => {
    const card = workCard({ id: 'w1', stage: 'ready', origin: 'legacy_team', team_id: 'team-1' },
      { operable: 'legacy_team', team: { id: 'team-1', title: 'Compiler team' } })
    setup(card)
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    await within(inspector).findByText('kubecode.work.legacyNotice')
    expect(within(inspector).queryByRole('button', { name: 'kubecode.work.command.start' })).not.toBeInTheDocument()
    expect(within(inspector).queryByRole('region', { name: 'kubecode.work.commands' })).not.toBeInTheDocument()
  })

  it('turns drops into commands, opens a form when one is needed, and refuses the rest', async () => {
    const ready = workCard({ id: 'ready', title: 'Ready one', stage: 'ready', state_revision: 2 }, { executor, assignment })
    const bare = workCard({ id: 'bare', title: 'Bare one', stage: 'ready' })
    const review = workCard({ id: 'rev', title: 'Review one', stage: 'review' }, { executor, assignment })
    const workCommand = vi.fn().mockResolvedValue(ready)
    const workBoard = vi.fn().mockResolvedValue(boardOf([ready, bare, review]))
    const workDetail = vi.fn().mockImplementation(async (_p: string, id: string) => detailOf(
      [ready, bare, review].find((card) => card.item.id === id)!,
    ))
    view(workApi({ workBoard, workDetail, workCommand }))
    await screen.findByText('Ready one')
    const drag = (id: string, column: string) => {
      const data = { setData: vi.fn(), effectAllowed: '' }
      fireEvent.dragStart(screen.getByTestId(`work-card-${id}`), { dataTransfer: data })
      fireEvent.dragOver(screen.getByTestId(`work-column-${column}`), { dataTransfer: data })
      fireEvent.drop(screen.getByTestId(`work-column-${column}`), { dataTransfer: data })
    }
    // Ready → Executing with an executor is the start command.
    drag('ready', 'executing')
    await waitFor(() => expect(workCommand).toHaveBeenCalledWith('p1', 'ready', 2, {
      command: 'start', request_key: expect.any(String),
    }))
    // Without an executor it asks which Session instead of guessing.
    drag('bare', 'executing')
    expect(await screen.findByRole('combobox', { name: 'kubecode.work.command.chooseSession' })).toBeInTheDocument()
    // Review → Done never completes by itself: it opens the accept form.
    drag('rev', 'done')
    expect(await screen.findByRole('combobox', { name: 'kubecode.work.review.outcome' })).toBeInTheDocument()
    expect(workCommand).toHaveBeenCalledTimes(1)
    // A move that is not a command is refused with an explanation.
    drag('ready', 'done')
    expect(await screen.findByText('kubecode.work.moveUnsupported')).toBeInTheDocument()
    expect(workCommand).toHaveBeenCalledTimes(1)
  })
})

describe('WorkBoard new task', () => {
  it('adds a task once even if the request is retried, and opens its card', async () => {
    const created = workCard({ id: 'new', title: 'Try dropout', stage: 'ready' })
    const createWork = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(created)
    const workBoard = vi.fn().mockResolvedValue(boardOf([]))
    const workDetail = vi.fn().mockResolvedValue(detailOf(created))
    view(workApi({ workBoard, createWork, workDetail }), { filter: { thread_id: 't1' } })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.work.newTask' }))
    fireEvent.change(screen.getByLabelText('kubecode.research.field.title'), { target: { value: ' Try dropout ' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.work.createTask' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.work.createTask' }))
    await waitFor(() => expect(createWork).toHaveBeenCalledTimes(2))
    expect(createWork.mock.calls[0][1].clientRequestId).toBe(createWork.mock.calls[1][1].clientRequestId)
    // From a Thread's board the task is born of that Thread.
    expect(createWork.mock.calls[1][1]).toMatchObject({ title: 'Try dropout', threadId: 't1' })
    expect(await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })).toBeInTheDocument()
  })
})

describe('StartKeys', () => {
  it('keeps one key per card and attempt until the start succeeds, then rotates', () => {
    let n = 0
    const keys = new StartKeys(() => `key-${++n}`)
    const card = workCard({ id: 'w1' }, { attempt_count: 0 })
    expect(keys.keyFor(card)).toBe('key-1')
    expect(keys.keyFor(card)).toBe('key-1')
    keys.done(card)
    expect(keys.keyFor(card)).toBe('key-2')
    // Once an attempt has run, the next start is a new request even if the old key was kept.
    const retried = workCard({ id: 'w1' }, { attempt_count: 1 })
    expect(keys.keyFor(retried)).toBe('key-3')
    expect(keys.keyFor(workCard({ id: 'other' }))).toBe('key-4')
  })
})

describe('WorkBoard review regressions', () => {
  it('shows a closed card with the reason it was closed and a removed executor plainly', async () => {
    const closed = workCard({ id: 'gone', title: 'Dropped', lifecycle: 'canceled', closed_reason: 'plan B won' })
    const removed = workCard({ id: 'orphan', title: 'Orphaned', stage: 'ready' }, {
      assignment, executor: { ...executor, title: '', available: false },
    })
    view(
      workApi({ workBoard: vi.fn().mockResolvedValue(boardOf([removed], [closed])) }),
      { filter: { include_closed: true } },
    )
    const lane = await screen.findByTestId('work-closed-lane')
    expect(within(lane).getByText(/kubecode.work.closedReason.*plan B won/)).toBeInTheDocument()
    expect(within(screen.getByTestId('work-card-orphan')).getByText('kubecode.work.executorRemoved')).toBeInTheDocument()
  })

  it('shows the objective and the latest progress on the card', async () => {
    const card = workCard(
      { id: 'w1', title: 'Sweep', description: 'Try a few pruning ratios and compare accuracy' },
      { latest_attempt: { id: 'a', task_id: 'w1', assignment_id: null, conversation_id: null, run_id: null,
        status: 'running', failure_kind: null, error: null, created_at: '', updated_at: '', completed_at: null } },
    )
    view(workApi({ workBoard: vi.fn().mockResolvedValue(boardOf([card])) }))
    const shown = await screen.findByTestId('work-card-w1')
    expect(shown).toHaveTextContent('Try a few pruning ratios')
    expect(shown).toHaveTextContent('kubecode.work.latestAttempt')
    expect(shown).toHaveTextContent('kubecode.work.attemptStatus.running')
  })

  it('opens the accept form for Review to Done and the request-changes form for Review to Executing', async () => {
    const review = workCard({ id: 'rev', title: 'Review one', stage: 'review' }, { executor, assignment })
    const workBoard = vi.fn().mockResolvedValue(boardOf([review]))
    const workDetail = vi.fn().mockResolvedValue(detailOf(review))
    view(workApi({ workBoard, workDetail, workCommand: vi.fn() }))
    await screen.findByText('Review one')
    const drag = (column: string) => {
      const data = { setData: vi.fn(), effectAllowed: '' }
      fireEvent.dragStart(screen.getByTestId('work-card-rev'), { dataTransfer: data })
      fireEvent.drop(screen.getByTestId(`work-column-${column}`), { dataTransfer: data })
    }
    drag('done')
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    await within(inspector).findByRole('button', { name: 'kubecode.work.command.accept' })
    expect(within(inspector).queryByRole('button', { name: 'kubecode.work.command.reject' })).not.toBeInTheDocument()
    drag('executing')
    await waitFor(() => expect(within(screen.getByRole('complementary', { name: 'kubecode.work.inspector' }))
      .queryByRole('button', { name: 'kubecode.work.command.accept' })).not.toBeInTheDocument())
    expect(within(screen.getByRole('complementary', { name: 'kubecode.work.inspector' }))
      .getByRole('button', { name: 'kubecode.work.command.reject' })).toBeInTheDocument()
  })

  it('does not offer pause over a condition someone else raised, and supersedes with a replacement', async () => {
    const flagged = workCard({ id: 'flag', title: 'Needs you', stage: 'executing', condition: 'needs_input' }, { executor, assignment })
    const other = workCard({ id: 'other', title: 'The replacement', stage: 'ready' })
    const workCommand = vi.fn().mockResolvedValue(flagged)
    const workBoard = vi.fn().mockResolvedValue(boardOf([flagged, other]))
    const workDetail = vi.fn().mockImplementation(async (_p: string, id: string) => detailOf(id === 'flag' ? flagged : other))
    view(workApi({ workBoard, workDetail, workCommand }))
    fireEvent.click(await screen.findByTestId('work-card-flag'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    await within(inspector).findByRole('button', { name: 'kubecode.work.command.cancel' })
    expect(within(inspector).queryByRole('button', { name: 'kubecode.work.command.pause' })).not.toBeInTheDocument()
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.command.cancel' }))
    fireEvent.change(within(inspector).getByRole('textbox', { name: 'kubecode.work.review.reason' }), { target: { value: 'replaced' } })
    await choose(inspector, 'kubecode.work.command.chooseReplacement', 'The replacement')
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.lifecycle.superseded' }))
    await waitFor(() => expect(workCommand).toHaveBeenCalledWith('p1', 'flag', 3, {
      command: 'close', lifecycle: 'superseded', reason: 'replaced', expected_revision: 1, superseded_by: 'other',
    }))
  })

  it('reopens the drag-requested form after it was cancelled and keeps one refetch per event burst', async () => {
    const ready = workCard({ id: 'bare', title: 'Bare one', stage: 'ready' })
    const workBoard = vi.fn().mockResolvedValue(boardOf([ready]))
    const workDetail = vi.fn().mockResolvedValue(detailOf(ready))
    const v = view(workApi({ workBoard, workDetail, workCommand: vi.fn() }))
    await screen.findByText('Bare one')
    const drag = () => {
      const data = { setData: vi.fn(), effectAllowed: '' }
      fireEvent.dragStart(screen.getByTestId('work-card-bare'), { dataTransfer: data })
      fireEvent.drop(screen.getByTestId('work-column-executing'), { dataTransfer: data })
    }
    drag()
    expect(await screen.findByRole('combobox', { name: 'kubecode.work.command.chooseSession' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.work.closeInspector' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'kubecode.work.inspector' })).not.toBeInTheDocument())
    drag()
    expect(await screen.findByRole('combobox', { name: 'kubecode.work.command.chooseSession' })).toBeInTheDocument()

    // Several events at once are one refetch.
    const before = workBoard.mock.calls.length
    await act(async () => v.update([workEvent(5), workEvent(6), workEvent(7)]))
    await waitFor(() => expect(workBoard.mock.calls.length).toBeGreaterThan(before))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(workBoard.mock.calls.length).toBe(before + 1)
  })

  it('says so when a refresh fails after the board loaded', async () => {
    const workBoard = vi.fn().mockResolvedValue(boardOf([workCard({ id: 'w1', title: 'One' })]))
    const v = view(workApi({ workBoard }))
    await screen.findByText('One')
    workBoard.mockRejectedValue(new Error('down'))
    await act(async () => v.update([workEvent(9)]))
    expect(await screen.findByText(/kubecode.work.refreshFailed/)).toBeInTheDocument()
    expect(screen.getByText('One')).toBeInTheDocument()
  })

  it('ignores a slow response that arrives after a newer one', async () => {
    const slow: { resolve?: (board: ReturnType<typeof boardOf>) => void } = {}
    const workBoard = vi.fn()
      .mockResolvedValueOnce(boardOf([workCard({ id: 'w1', title: 'First' })]))
      .mockImplementationOnce(() => new Promise((resolve) => { slow.resolve = resolve }))
      .mockResolvedValue(boardOf([workCard({ id: 'w1', title: 'Newest' })]))
    const v = view(workApi({ workBoard }))
    await screen.findByText('First')
    await act(async () => v.update([workEvent(2)]))
    await waitFor(() => expect(workBoard).toHaveBeenCalledTimes(2))
    await act(async () => v.update([workEvent(2), workEvent(3)]))
    expect(await screen.findByText('Newest')).toBeInTheDocument()
    await act(async () => slow.resolve?.(boardOf([workCard({ id: 'w1', title: 'Stale' })])))
    expect(screen.queryByText('Stale')).not.toBeInTheDocument()
    expect(screen.getByText('Newest')).toBeInTheDocument()
  })
})

describe('WorkBoard analysis and evidence', () => {
  const analyzing = workCard({ id: 'w1', stage: 'analyzing', state_revision: 6 }, { executor, assignment })

  function open(detail: ReturnType<typeof detailOf>, extra: object = {}) {
    const workBoard = vi.fn().mockResolvedValue(boardOf([detail]))
    const workDetail = vi.fn().mockResolvedValue(detail)
    const workCommand = vi.fn().mockResolvedValue(detail)
    view(workApi({ workBoard, workDetail, workCommand, ...extra }))
    return { workCommand, workDetail }
  }

  it('says a finished experiment awaits analysis and shows what was decided about earlier ones', async () => {
    open(detailOf(analyzing, {
      experiments: [{ id: 'e1', label: 'baseline', state: 'exited', analysis: 'pending', exit_code: 3, created_at: '' }],
      decisions: [{
        id: 'd1', experiment_id: 'e0', kind: 'retry', rationale: 'loss diverged at 4 heads',
        launched_experiment_id: 'e1', created_at: '',
      }],
    }))
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    expect(await within(inspector).findByText('kubecode.work.analysisWaiting')).toBeInTheDocument()
    expect(inspector).toHaveTextContent('kubecode.work.decisionKind.retry')
    expect(inspector).toHaveTextContent('loss diverged at 4 heads')
  })

  it('shows changed evidence and re-pins it only when the researcher asks', async () => {
    const card = workCard({ id: 'w1', stage: 'review', state_revision: 4 }, { executor, assignment })
    const { workCommand } = open(detailOf(card, {
      results: [{ id: 'x', task_id: 'w1', attempt_id: null, role: 'evidence', kind: 'file', ref_id: 'notes.md', revision: 'a', created_at: '' }],
      stale_evidence: [{ result_id: 'x', kind: 'file', ref_id: 'notes.md', status: 'changed' }],
    }))
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    expect(await within(inspector).findByText('kubecode.work.stale.hint')).toBeInTheDocument()
    expect(workCommand).not.toHaveBeenCalled()
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.command.repin' }))
    await waitFor(() => expect(workCommand).toHaveBeenCalledWith('p1', 'w1', 4, { command: 'repin', result_id: 'x' }))
  })

  it('sends a Task\'s changed evidence to the Task\'s Results instead of re-pinning it here', async () => {
    const card = workCard(
      { id: 'w1', stage: 'review', state_revision: 4 },
      { executor, assignment, research: { id: 'r1', title: 'Pruning', task: true } },
    )
    const { workCommand } = open(detailOf(card, {
      results: [{ id: 'x', task_id: 'w1', attempt_id: null, role: 'evidence', kind: 'file', ref_id: 'notes.md', revision: 'a', created_at: '' }],
      stale_evidence: [{ result_id: 'x', kind: 'file', ref_id: 'notes.md', status: 'changed' }],
    }))
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    expect(await within(inspector).findByText('kubecode.work.stale.taskHint')).toBeInTheDocument()
    expect(within(inspector).queryByRole('button', { name: 'kubecode.work.command.repin' })).not.toBeInTheDocument()
    expect(workCommand).not.toHaveBeenCalled()
  })

  it('explains a refused acceptance when evidence changed under the researcher', async () => {
    const card = workCard({ id: 'w1', stage: 'review', state_revision: 4 }, { executor, assignment })
    const workCommand = vi.fn().mockRejectedValue(new ApiError('work_evidence_stale', 'x', 409))
    const { workDetail } = open(detailOf(card), { workCommand })
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const initial = workDetail.mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.work.command.accept' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.work.error.evidenceStale')
    // The inspector reloads so the changed evidence and its re-pin control appear.
    await waitFor(() => expect(workDetail.mock.calls.length).toBeGreaterThan(initial))
  })

  it('answers a question with an offered option, and says the answer grants nothing', async () => {
    const answerWorkDecision = vi.fn().mockResolvedValue({})
    open(detailOf(analyzing, {
      decision_requests: [
        {
          id: 'q1', work_id: 'w1', question: 'Spend more budget?', options: ['yes', 'no'], impact: 'one more day',
          asked_by: 's1', state: 'open', answer: null, created_at: '',
        },
        {
          id: 'q2', work_id: 'w1', question: 'Which dataset?', options: [], impact: null,
          asked_by: 's1', state: 'answered', answer: 'wiki', created_at: '',
        },
      ],
    }), { answerWorkDecision })
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    const send = await within(inspector).findByRole('button', { name: 'kubecode.work.question.answer' })
    expect(send).toBeDisabled()
    expect(inspector).toHaveTextContent('kubecode.work.question.note')
    expect(inspector).toHaveTextContent('kubecode.work.question.answered:{"answer":"wiki"}')
    await choose(inspector, 'Spend more budget? — kubecode.work.question.choose', 'yes')
    fireEvent.click(send)
    await waitFor(() => expect(answerWorkDecision).toHaveBeenCalledWith('p1', 'w1', 'q1', 'yes'))
  })

  it('renders a question whose offered options include blank or duplicate strings', async () => {
    const answerWorkDecision = vi.fn().mockResolvedValue({})
    open(detailOf(analyzing, {
      decision_requests: [{
        id: 'q1', work_id: 'w1', question: 'Proceed?', options: ['', '  ', 'yes', 'yes'], impact: null,
        asked_by: 's1', state: 'open', answer: null, created_at: '',
      }],
    }), { answerWorkDecision })
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    fireEvent.click(within(inspector).getByRole('combobox', { name: 'Proceed? — kubecode.work.question.choose' }))
    expect(await screen.findAllByRole('option')).toHaveLength(1)
    fireEvent.click(screen.getByRole('option', { name: 'yes' }))
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.question.answer' }))
    await waitFor(() => expect(answerWorkDecision).toHaveBeenCalledWith('p1', 'w1', 'q1', 'yes'))
  })
})

describe('WorkBoard evidence review', () => {
  const card = workCard({ id: 'w1', stage: 'review' }, { executor, assignment })
  const document = (title: string, text: string, extra: object = {}) => ({
    ref: { kind: 'experiment', id: 'e1' }, detail: 'content', title, availability: 'available',
    provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
    sections: [{ heading: 'Output', text, truncated: false }], related: [], next_cursor: null, notes: [],
    ...extra,
  })

  function open(detail: ReturnType<typeof detailOf>, api: object) {
    view(workApi({
      workBoard: vi.fn().mockResolvedValue(boardOf([detail])),
      workDetail: vi.fn().mockResolvedValue(detail),
      ...api,
    }))
  }

  it('opens an experiment from the card with its output and follows a related artifact', async () => {
    const readProjectContext = vi.fn()
      .mockResolvedValueOnce(document('baseline run', 'epoch 3 loss nan', {
        related: [{
          ref: { kind: 'artifact', id: 'e1/out.csv' }, title: 'out.csv', summary: '',
          provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
          availability: 'available',
        }],
      }))
      .mockResolvedValueOnce(document('out.csv', 'ratio,acc\n0.5,0.91'))
    open(detailOf(card, {
      experiments: [{ id: 'e1', label: 'baseline', state: 'exited', analysis: 'none', exit_code: 3, created_at: '' }],
    }), { readProjectContext })
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    expect(inspector).toHaveTextContent('kubecode.work.exitCode:{"code":3}')
    fireEvent.click(await within(inspector).findByRole('button', { name: 'kubecode.work.evidence.view: baseline' }))
    expect(await within(inspector).findByText('epoch 3 loss nan')).toBeInTheDocument()
    expect(readProjectContext).toHaveBeenCalledWith('p1', { kind: 'experiment', id: 'e1' }, 'content')
    fireEvent.click(within(inspector).getByRole('button', { name: 'out.csv' }))
    expect(await within(inspector).findByText(/0\.5,0\.91/)).toBeInTheDocument()
    expect(readProjectContext).toHaveBeenLastCalledWith('p1', { kind: 'artifact', id: 'e1/out.csv' }, 'content')
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.evidence.hide: baseline' }))
    expect(within(inspector).queryByTestId('evidence-viewer')).not.toBeInTheDocument()
  })

  it('shows a cited file as it is now and says it changed since it was cited', async () => {
    // Read through the context reader, with the fingerprint evidence is pinned with (ADR 0231 §1).
    const readProjectContext = vi.fn().mockResolvedValue(fileDocument('notes.md', 'pruning hurts', 'bbbbbbbbbbbbbbbb'))
    open(detailOf(card, {
      results: [{
        id: 'x', task_id: 'w1', attempt_id: null, role: 'evidence', kind: 'file', ref_id: 'notes.md',
        revision: 'aaaaaaaaaaaaaaaa', created_at: '',
      }],
    }), { readProjectContext })
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    fireEvent.click(await within(inspector).findByRole('button', { name: 'kubecode.work.evidence.view: notes.md' }))
    expect(await within(inspector).findByText('pruning hurts')).toBeInTheDocument()
    expect(readProjectContext).toHaveBeenCalledWith('p1', { kind: 'file', id: 'notes.md' }, 'content')
    expect(inspector).toHaveTextContent('kubecode.work.evidence.changed')
    expect(inspector).toHaveTextContent('kubecode.work.evidence.pinned:{"revision":"kubecode.reference.version.digest:{\\"revision\\":\\"aaaaaaa\\"}"}')
  })

  it('says plainly when a cited record is gone or cannot be read, and pages long output', async () => {
    const readProjectContext = vi.fn()
      .mockRejectedValueOnce(new ApiError('not_found', 'gone', 404))
      .mockResolvedValueOnce(document('long run', 'first page', { next_cursor: 'c2' }))
      .mockResolvedValueOnce(document('long run', 'second page'))
    open(detailOf(card, {
      results: [
        { id: 'a', task_id: 'w1', attempt_id: null, role: 'evidence', kind: 'finding', ref_id: 'f-gone', revision: null, created_at: '' },
        { id: 'b', task_id: 'w1', attempt_id: null, role: 'evidence', kind: 'experiment', ref_id: 'e-long', revision: null, created_at: '' },
      ],
    }), { readProjectContext })
    fireEvent.click(await screen.findByTestId('work-card-w1'))
    const inspector = await screen.findByRole('complementary', { name: 'kubecode.work.inspector' })
    fireEvent.click(await within(inspector).findByRole('button', { name: 'kubecode.work.evidence.view: f-gone' }))
    expect(await within(inspector).findByRole('alert')).toHaveTextContent('kubecode.work.evidence.removed')
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.evidence.view: e-long' }))
    expect(await within(inspector).findByText('first page')).toBeInTheDocument()
    fireEvent.click(within(inspector).getByRole('button', { name: 'kubecode.work.evidence.more' }))
    expect(await within(inspector).findByText('second page')).toBeInTheDocument()
    expect(within(inspector).getByText('first page')).toBeInTheDocument()
  })
})
