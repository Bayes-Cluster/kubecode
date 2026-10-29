import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { TaskBoard, TaskCard, TaskDraft } from '../api'
import { createPlaceMemory, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { nextFrame, stubScrollGeometry } from '@/test/scrollGeometry'
import { taskBoard, taskCard } from './taskFixtures'
import { TaskBoardView, type TaskBoardViewProps } from './TaskBoardView'

const t = createTranslator('en')

const card = (overrides: Partial<TaskCard>): TaskCard => taskCard({ title: 'Pruning', ...overrides })

const board = (cards: TaskCard[], archived: TaskBoard['archived'] = []): TaskBoard => taskBoard(cards, archived)

function view(props: Partial<TaskBoardViewProps> = {}) {
  const handlers = { onOpenTask: vi.fn(), onOpenGeneral: vi.fn(), onReload: vi.fn() }
  const rendered = render(
    <TaskBoardView board={null} drafts={[]} status="ready" t={t} {...handlers} {...props} />,
  )
  return { ...rendered, ...handlers }
}

const draft = (overrides: Partial<TaskDraft> = {}): TaskDraft => ({
  id: 'd1', project_id: 'p1', title: 'Quantize', question: '?', revision: 2, proposed_by: 'agent', updated_at: '', ...overrides,
})

describe('TaskBoardView', () => {
  it('marks the cards that wait on the researcher, so the next decisions are easy to find', () => {
    view({
      board: board([
        card({ id: 'r1', title: 'Quiet' }),
        card({ id: 'r3', title: 'Awaiting', stage: 'review', review_requested: true }),
      ]),
    })
    // The needs-you mark rides the card shell (the shell carries the card's
    // own state; the buttons inside carry the actions).
    expect(screen.getByTestId('task-card-r3').closest('.agx-board__card')).toHaveAttribute('data-needs-you', 'true')
    expect(screen.getByTestId('task-card-r1').closest('.agx-board__card')).not.toHaveAttribute('data-needs-you')
  })

  it('shows one lifecycle: four stages, with conditions, the action asked of you and progress on the cards', () => {
    const { onOpenTask } = view({
      board: board([
        card({ id: 'r1', title: 'Ready one' }),
        card({
          id: 'r2', title: 'Running', stage: 'in_progress', condition: 'blocked', condition_reason: 'needs GPU',
          work: { total: 2, active: 1, in_review: 0, done: 1, needs_input: 0, blocked: 1 },
          last_event: { seq: 2, kind: 'execution_authorized', ref_id: null, created_at: '2026-10-20 09:30:00' },
        }),
        card({ id: 'r3', title: 'Awaiting', stage: 'review', review_requested: true, revision: 3, approved_revision: 2 }),
        card({ id: 'r4', title: 'Finished', stage: 'done', outcome: 'refuted' }),
        card({ id: 'r5', title: 'Asking', stage: 'in_progress', open_questions: 1 }),
      ]),
    })
    expect(screen.getByRole('heading', { name: 'Kanban', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^back/i })).not.toBeInTheDocument()
    const columns = screen.getAllByRole('region').filter((region) => region.hasAttribute('data-stage'))
    expect(columns.map((column) => column.getAttribute('data-stage'))).toEqual(['ready', 'in_progress', 'review', 'done'])
    const running = within(screen.getByRole('region', { name: 'In progress' }))
    expect(running.getByText('Blocked')).toBeInTheDocument()
    // Why, in words on the card itself (reachable on touch), in the app's language.
    expect(running.getByText('All of its active work is blocked.')).toBeVisible()
    expect(running.queryByText('needs GPU')).not.toBeInTheDocument()
    // The derived progress ring says the tally; the detail fold holds the
    // participants and the latest event, opened by its own disclosure.
    expect(running.getByRole('img', { name: '1 of 2 work items done' })).toBeInTheDocument()
    fireEvent.click(running.getByTestId('task-disclosure-r2'))
    expect(running.getByText('1 of 2 work items done')).toBeVisible()
    expect(running.getByText(/^Work started · /)).toBeInTheDocument()
    expect(running.getAllByText('Analyst').length).toBeGreaterThan(0)
    expect(running.getByText('Question for you')).toBeInTheDocument()
    const review = within(screen.getByRole('region', { name: 'Review' }))
    expect(review.getByText('Review results')).toBeInTheDocument()
    expect(review.getByText('Brief changed')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Valid negative result')).toBeInTheDocument()
    // No ring and no work line until the detail fold opens.
    const ready = within(screen.getByRole('region', { name: 'Ready' }))
    expect(ready.queryByRole('img', { name: /work items done/ })).toBeNull()
    fireEvent.click(ready.getByTestId('task-disclosure-r1'))
    expect(ready.getByText('No work yet')).toBeInTheDocument()
    expect(screen.queryByText(/Project manager/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-card-r4'))
    expect(onOpenTask).toHaveBeenCalledWith('r4')
  })

  it('has no drag and no control that moves, admits or starts a Task: the card holds an open button and its own disclosure, nothing else', () => {
    const { container } = view({
      board: board([card({ id: 'r1' }), card({ id: 'r2', stage: 'review', review_requested: true })]),
      drafts: [draft()],
    })
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0)
    for (const button of screen.getAllByTestId(/^task-card-/)) expect(button.closest('.agx-board__card')).not.toBeNull()
    for (const button of screen.getAllByTestId(/^task-card-/)) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0)
    }
    expect(screen.queryByRole('button', { name: /add to|admit|approve|confirm|start|move/i })).not.toBeInTheDocument()
  })

  it('lists proposals above the stages, apart from them, and opens one', () => {
    const { onOpenTask } = view({ board: board([card({ id: 'r1' })]), drafts: [draft()] })
    const drafts = screen.getByText('Proposals not on the board (1)').closest('[data-slot="collapsible"]') as HTMLElement
    const firstColumn = screen.getByRole('region', { name: 'Ready' })
    expect(drafts.compareDocumentPosition(firstColumn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(drafts.closest('[data-stage]')).toBeNull()
    expect(drafts).toHaveAttribute('data-state', 'closed')
    fireEvent.click(screen.getByText('Proposals not on the board (1)'))
    fireEvent.click(within(drafts).getByRole('button', { name: /Quantize/ }))
    expect(onOpenTask).toHaveBeenCalledWith('d1')
    expect(screen.queryByText(/These are drafts/)).not.toBeInTheDocument()
  })

  it('opens the proposals when nothing is on the board yet', () => {
    view({ board: board([]), drafts: [draft()] })
    expect(screen.getByText('Proposals not on the board (1)').closest('[data-slot="collapsible"]')).toHaveAttribute('data-state', 'open')
  })

  it('shows one stage at a time on a narrow board, following the Task being inspected until another stage is picked', () => {
    const cards = [card({ id: 'r1', stage: 'in_progress' }), card({ id: 'r2', stage: 'review', review_requested: true })]
    const rendered = view({ board: board(cards) })
    const stages = within(screen.getByRole('tablist', { name: 'Stage' }))
    const selected = () => screen.getAllByRole('region')
      .filter((region) => region.getAttribute('data-selected') === 'true')
      .map((region) => region.getAttribute('data-stage'))
    expect(selected()).toEqual(['review'])
    expect(stages.getByRole('tab', { name: 'Review · 1' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.mouseDown(stages.getByRole('tab', { name: 'Ready · 0' }))
    expect(selected()).toEqual(['ready'])
    expect(within(screen.getByRole('region', { name: 'Ready' })).getByText('Nothing here.')).toBeInTheDocument()
    rendered.rerender(<TaskBoardView board={board(cards)} drafts={[]} selectedId="r1" status="ready" t={t} onOpenGeneral={vi.fn()} onOpenTask={vi.fn()} onReload={vi.fn()} />)
    expect(selected()).toEqual(['in_progress'])
    // The inspected Task moves to Review: the stage follows it.
    const moved = [card({ id: 'r1', stage: 'review', review_requested: true }), cards[1]]
    rendered.rerender(<TaskBoardView board={board(moved)} drafts={[]} selectedId="r1" status="ready" t={t} onOpenGeneral={vi.fn()} onOpenTask={vi.fn()} onReload={vi.fn()} />)
    expect(selected()).toEqual(['review'])
    fireEvent.mouseDown(stages.getByRole('tab', { name: 'In progress · 0' }))
    expect(selected()).toEqual(['in_progress'])
    expect(screen.getByTestId('task-card-r1')).toHaveAttribute('aria-current', 'true')
  })

  it('returns focus to the card of the Task that was closed when nothing else holds it', () => {
    const cards = [card({ id: 'r1', stage: 'done' })]
    const props = { board: board(cards), drafts: [], status: 'ready' as const, t, onOpenGeneral: vi.fn(), onOpenTask: vi.fn(), onReload: vi.fn() }
    const rendered = render(<TaskBoardView {...props} selectedId="r1" />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    rendered.rerender(<TaskBoardView {...props} selectedId={null} />)
    expect(screen.getByTestId('task-card-r1')).toHaveFocus()
  })

  it('keeps focus on a closed Task\'s card, and shows its stage, when the board learns it moved column after the close', () => {
    const props = { drafts: [], status: 'ready' as const, t, onOpenGeneral: vi.fn(), onOpenTask: vi.fn(), onReload: vi.fn() }
    const before = board([card({ id: 'r1', stage: 'review', review_requested: true }), card({ id: 'r2', stage: 'ready' })])
    const rendered = render(<TaskBoardView {...props} board={before} selectedId="r1" />)
    screen.getByTestId('task-card-r1').focus()
    rendered.rerender(<TaskBoardView {...props} board={before} selectedId={null} />)
    expect(screen.getByTestId('task-card-r1')).toHaveFocus()
    const after = board([card({ id: 'r1', stage: 'in_progress' }), card({ id: 'r2', stage: 'ready' })])
    rendered.rerender(<TaskBoardView {...props} board={after} selectedId={null} />)
    expect(screen.getByRole('region', { name: 'In progress' })).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('task-card-r1')).toHaveFocus()
    // Once the researcher moves on, the board leaves focus alone.
    fireEvent.keyDown(document.body, { key: 'Tab' })
    screen.getByTestId('task-card-r2').focus()
    rendered.rerender(<TaskBoardView {...props} board={board([card({ id: 'r1', stage: 'review' }), card({ id: 'r2', stage: 'ready' })])} selectedId={null} />)
    expect(screen.getByTestId('task-card-r2')).toHaveFocus()
  })

  it('narrows to what needs the researcher, keeping counts of what is shown', () => {
    view({ board: board([
      card({ id: 'r1', title: 'Quiet' }),
      card({ id: 'r2', title: 'Awaiting', stage: 'review', review_requested: true }),
    ]) })
    fireEvent.click(screen.getByRole('switch', { name: 'Needs you only' }))
    expect(screen.queryByText('Quiet')).not.toBeInTheDocument()
    expect(screen.getByText('Awaiting')).toBeInTheDocument()
    expect(within(screen.getByRole('tablist', { name: 'Stage' })).getByRole('tab', { name: 'Ready · 0' })).toBeInTheDocument()
  })

  it('says once that nothing needs the researcher, instead of four empty columns', () => {
    view({ board: board([card({ id: 'r1', title: 'Quiet' }), card({ id: 'r2', title: 'Busy', stage: 'in_progress' })]) })
    fireEvent.click(screen.getByRole('switch', { name: 'Needs you only' }))
    expect(screen.getByText('Nothing on the board needs you right now.')).toBeInTheDocument()
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('region').filter((region) => region.hasAttribute('data-stage'))).toHaveLength(0)
    fireEvent.click(screen.getByRole('switch', { name: 'Needs you only' }))
    expect(screen.getByText('Quiet')).toBeInTheDocument()
  })

  it('says how a Task gets here when there is none, and goes to General', () => {
    const { onOpenGeneral } = view({ board: board([]) })
    expect(screen.getByText(/No Tasks yet/).closest('[data-slot="empty"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Go to General' }))
    expect(onOpenGeneral).toHaveBeenCalled()
  })

  it('lists archived Tasks apart, and opens one to restore it', () => {
    const { onOpenTask } = view({ board: board([card({ id: 'r1' })], [
      { id: 'r9', title: 'Old sweep', stage: 'done', outcome: 'supported', updated_at: '' },
      { id: 'd9', title: 'Old idea', stage: null, outcome: null, updated_at: '' },
    ]) })
    const archived = screen.getByText('Archived (2)').closest('[data-slot="collapsible"]') as HTMLElement
    expect(archived.closest('[data-stage]')).toBeNull()
    fireEvent.click(screen.getByText('Archived (2)'))
    expect(within(archived).getByRole('button', { name: /Old idea.*Proposal/ })).toBeInTheDocument()
    fireEvent.click(within(archived).getByRole('button', { name: /Old sweep.*Done.*Supports the hypothesis/ }))
    expect(onOpenTask).toHaveBeenCalledWith('r9')
  })

  it('loads, and retries a board that failed', () => {
    const loading = view({ status: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading Tasks…')
    expect(screen.getByRole('status').querySelector('[data-slot="spinner"], svg')).not.toBeNull()
    loading.unmount()
    const { onReload } = view({ status: 'error' })
    expect(screen.getByRole('alert')).toHaveAttribute('data-slot', 'alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onReload).toHaveBeenCalled()
  })
})

describe('TaskBoardView on official components (#259)', () => {
  it('lists proposals and archived Tasks as official Item rows, and says an empty column or filter with Empty', () => {
    view({
      board: board([card({ id: 'r1', title: 'Quiet' })], [{ id: 'r9', title: 'Old sweep', stage: 'done', outcome: 'supported', updated_at: '' }]),
      drafts: [draft()],
    })
    fireEvent.click(screen.getByText('Archived (1)'))
    expect(screen.getByRole('button', { name: /Old sweep/ })).toHaveAttribute('data-slot', 'item')
    fireEvent.click(screen.getByText(/Proposals/))
    expect(screen.getByRole('button', { name: /Quantize/ })).toHaveAttribute('data-slot', 'item')
    const review = screen.getAllByRole('region').find((region) => region.getAttribute('data-stage') === 'review') as HTMLElement
    expect(within(review).getByText('Nothing here.').closest('.agx-board__empty')).not.toBeNull()
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByText('Nothing on the board needs you right now.').closest('[data-slot="empty"]')).not.toBeNull()
  })

  it('names its Needs-you filter with a Field label, so the words toggle it too', () => {
    view({ board: board([card({ id: 'r1' })]) })
    fireEvent.click(screen.getByText('Needs you only'))
    expect(screen.getByRole('switch', { name: 'Needs you only' })).toBeChecked()
  })
})

describe('TaskBoardView keeps its place (ADR 0228 §4)', () => {
  const boardIn = (memory: PlaceMemory, cards: TaskCard[] | null) => (
    <PlaceMemoryProvider memory={memory}>
      <TaskBoardView
        board={cards ? board(cards) : null}
        drafts={[]}
        scrollKey="p1|view:board"
        status={cards ? 'ready' : 'loading'}
        t={t}
        onOpenGeneral={vi.fn()}
        onOpenTask={vi.fn()}
        onReload={vi.fn()}
      />
    </PlaceMemoryProvider>
  )

  it('returns to where the board was scrolled once its cards are back, and names each card for focus return', async () => {
    const restore = stubScrollGeometry()
    try {
      const memory = createPlaceMemory()
      const cards = [card({ id: 'r1' }), card({ id: 'r2', title: 'Second' })]
      const view = render(boardIn(memory, cards))
      expect(screen.getByTestId('task-card-r2')).toHaveAttribute('data-focus-key', 'card:r2')
      expect(screen.getByTestId('task-card-r2')).toHaveAttribute('data-scroll-anchor', 'card:r2')
      const scroller = screen.getByRole('region', { name: 'Kanban' })
      scroller.scrollTop = 130
      fireEvent.scroll(scroller)
      await act(nextFrame)

      view.rerender(<PlaceMemoryProvider memory={memory}><p>General</p></PlaceMemoryProvider>)
      view.rerender(boardIn(memory, null))
      const again = screen.getByRole('region', { name: 'Kanban' })
      expect(again.scrollTop).toBe(0)
      view.rerender(boardIn(memory, cards))
      expect(again.scrollTop).toBe(130)
    } finally {
      restore()
    }
  })
})

describe('board under rapid updates and at scale (ADR 0257, slice G)', () => {
  it('keeps ordering, focus and selected identity across a burst of board rewrites', () => {
    const cards = [
      taskCard({ id: 'r1', title: 'First', stage: 'ready' }),
      taskCard({ id: 'r2', title: 'Second', stage: 'in_progress' }),
      taskCard({ id: 'r3', title: 'Third', stage: 'review', review_requested: true }),
    ]
    const props = { drafts: [] as TaskDraft[], status: 'ready' as const, t }
    const mounted = view({ board: board(cards), ...props })
    const selected = within(screen.getByRole('region', { name: 'Review' })).getByTestId('task-card-r3')
    act(() => {
      selected.focus()
    })
    expect(document.activeElement).toBe(selected)

    // A burst: five rewrites in one batch, reordering and adding columns' worth.
    for (let round = 0; round < 5; round += 1) {
      mounted.rerender(<TaskBoardView
        board={board([
          taskCard({ id: 'r3', title: 'Third', stage: 'review', review_requested: true }),
          taskCard({ id: 'r1', title: `First ${round}`, stage: 'ready' }),
          taskCard({ id: 'r2', title: 'Second', stage: 'in_progress' }),
          taskCard({ id: `r-new-${round}`, title: 'Newcomer', stage: 'ready' }),
        ])}
        {...props}
      />)
    }
    // The inspected card keeps its identity and its focus, and the columns
    // keep their order.
    expect(document.activeElement).toBe(
      within(screen.getByRole('region', { name: 'Review' })).getByTestId('task-card-r3'),
    )
    const order = screen.getAllByRole('region').filter((r) => r.hasAttribute('data-stage'))
      .map((r) => r.getAttribute('data-stage'))
    expect(order).toEqual(['ready', 'in_progress', 'review', 'done'])
  })

  it('renders a large board (200 cards over four stages) inside the frame budget', () => {
    const stages = ['ready', 'in_progress', 'review', 'done'] as const
    const cards = Array.from({ length: 200 }, (_, index) => (
      taskCard({ id: `bulk-${index}`, title: `Task ${index}`, stage: stages[index % 4] })
    ))
    const started = performance.now()
    const props = { drafts: [] as TaskDraft[], status: 'ready' as const, t }
    const mounted = view({ board: board(cards), ...props })
    const elapsed = performance.now() - started
    expect(mounted.container.querySelectorAll('[data-focus-key^=\'card:\']')).toHaveLength(200)
    // Well under the 30s test timeout: a regression that re-renders the
    // board per streamed update shows up here as seconds, not milliseconds.
    expect(elapsed).toBeLessThan(2_000)
  })
})
