import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  Conversation, ResearchSummary, WorkBoardFilter, WorkCard, WorkspaceEvent,
} from '../api'
import { ApiError } from '../api'
import { WorkBoard } from './WorkBoard'
import { moveRequest } from './workModel'
import { boardOf, detailOf, workApi, workCard } from './workFixtures'

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

const executor = { session_id: 's1', title: 'Pruner', agent_id: 'opencode' as const }
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
    expect(within(screen.getByTestId('work-column-executing')).getByText('2', { selector: 'small' })).toBeInTheDocument()

    const run = screen.getByTestId('work-card-run')
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
    fireEvent.change(screen.getByLabelText('kubecode.work.field.research'), { target: { value: 'r1' } })
    expect(onFilterChange).toHaveBeenLastCalledWith({ research_id: 'r1' })
    fireEvent.change(screen.getByLabelText('kubecode.work.field.agent'), { target: { value: 's2' } })
    expect(onFilterChange).toHaveBeenLastCalledWith({ conversation_id: 's2' })
    fireEvent.click(within(screen.getByRole('status', { name: 'kubecode.work.attention' })).getByRole('button', { name: /kubecode.work.condition.waiting/ }))
    expect(onFilterChange).toHaveBeenLastCalledWith({ condition: 'waiting' })
    fireEvent.click(screen.getByLabelText('kubecode.work.filter.includeClosed'))
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
    fireEvent.change(await within(inspector).findByLabelText('kubecode.work.review.outcome'), { target: { value: 'refuted' } })
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
    expect(await screen.findByLabelText('kubecode.work.review.outcome')).toBeInTheDocument()
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
