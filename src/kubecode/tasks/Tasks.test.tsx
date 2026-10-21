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
    expect(screen.getByTestId('task-card-r3')).toHaveAttribute('data-needs-you', 'true')
    expect(screen.getByTestId('task-card-r1')).not.toHaveAttribute('data-needs-you')
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
    expect(running.getByText('1 of 2 work items done')).toBeInTheDocument()
    expect(running.getByText(/^Work started · /)).toBeInTheDocument()
    expect(running.getAllByText('Analyst').length).toBeGreaterThan(0)
    expect(running.getByText('Question for you')).toBeInTheDocument()
    const review = within(screen.getByRole('region', { name: 'Review' }))
    expect(review.getByText('Review results')).toBeInTheDocument()
    expect(review.getByText('Brief changed')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Valid negative result')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Ready' })).getByText('No work yet')).toBeInTheDocument()
    expect(screen.queryByText(/Project manager/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-card-r4'))
    expect(onOpenTask).toHaveBeenCalledWith('r4')
  })

  it('has no drag and no control that moves, admits or starts a Task: a card is one button', () => {
    const { container } = view({
      board: board([card({ id: 'r1' }), card({ id: 'r2', stage: 'review', review_requested: true })]),
      drafts: [draft()],
    })
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0)
    for (const button of screen.getAllByTestId(/^task-card-/)) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0)
    }
    expect(screen.queryByRole('button', { name: /add to|admit|approve|confirm|start|move/i })).not.toBeInTheDocument()
  })

  it('lists proposals above the stages, apart from them, and opens one', () => {
    const { onOpenTask } = view({ board: board([card({ id: 'r1' })]), drafts: [draft()] })
    const drafts = screen.getByText('Proposals not on the board (1)').closest('details') as HTMLElement
    const firstColumn = screen.getByRole('region', { name: 'Ready' })
    expect(drafts.compareDocumentPosition(firstColumn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(drafts.closest('[data-stage]')).toBeNull()
    expect(drafts).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText('Proposals not on the board (1)'))
    fireEvent.click(within(drafts).getByRole('button', { name: /Quantize/ }))
    expect(onOpenTask).toHaveBeenCalledWith('d1')
    expect(screen.queryByText(/These are drafts/)).not.toBeInTheDocument()
  })

  it('opens the proposals when nothing is on the board yet', () => {
    view({ board: board([]), drafts: [draft()] })
    expect(screen.getByText('Proposals not on the board (1)').closest('details')).toHaveAttribute('open')
  })

  it('shows one stage at a time on a narrow board, following the Task being inspected until another stage is picked', () => {
    const cards = [card({ id: 'r1', stage: 'in_progress' }), card({ id: 'r2', stage: 'review', review_requested: true })]
    const rendered = view({ board: board(cards) })
    const stages = within(screen.getByRole('group', { name: 'Stage' }))
    const selected = () => screen.getAllByRole('region')
      .filter((region) => region.getAttribute('data-selected') === 'true')
      .map((region) => region.getAttribute('data-stage'))
    expect(selected()).toEqual(['review'])
    expect(stages.getByRole('button', { name: 'Review · 1' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(stages.getByRole('button', { name: 'Ready · 0' }))
    expect(selected()).toEqual(['ready'])
    expect(within(screen.getByRole('region', { name: 'Ready' })).getByText('Nothing here.')).toBeInTheDocument()
    rendered.rerender(<TaskBoardView board={board(cards)} drafts={[]} selectedId="r1" status="ready" t={t} onOpenGeneral={vi.fn()} onOpenTask={vi.fn()} onReload={vi.fn()} />)
    expect(selected()).toEqual(['in_progress'])
    // The inspected Task moves to Review: the stage follows it.
    const moved = [card({ id: 'r1', stage: 'review', review_requested: true }), cards[1]]
    rendered.rerender(<TaskBoardView board={board(moved)} drafts={[]} selectedId="r1" status="ready" t={t} onOpenGeneral={vi.fn()} onOpenTask={vi.fn()} onReload={vi.fn()} />)
    expect(selected()).toEqual(['review'])
    fireEvent.click(stages.getByRole('button', { name: 'In progress · 0' }))
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
    expect(within(screen.getByRole('group', { name: 'Stage' })).getByRole('button', { name: 'Ready · 0' })).toBeInTheDocument()
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
    expect(screen.getByText(/No Tasks yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Go to General' }))
    expect(onOpenGeneral).toHaveBeenCalled()
  })

  it('lists archived Tasks apart, and opens one to restore it', () => {
    const { onOpenTask } = view({ board: board([card({ id: 'r1' })], [
      { id: 'r9', title: 'Old sweep', stage: 'done', outcome: 'supported', updated_at: '' },
      { id: 'd9', title: 'Old idea', stage: null, outcome: null, updated_at: '' },
    ]) })
    const archived = screen.getByText('Archived (2)').closest('details') as HTMLElement
    expect(archived.closest('[data-stage]')).toBeNull()
    fireEvent.click(screen.getByText('Archived (2)'))
    expect(within(archived).getByRole('button', { name: /Old idea.*Proposal/ })).toBeInTheDocument()
    fireEvent.click(within(archived).getByRole('button', { name: /Old sweep.*Done.*Supports the hypothesis/ }))
    expect(onOpenTask).toHaveBeenCalledWith('r9')
  })

  it('loads, and retries a board that failed', () => {
    const loading = view({ status: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading Tasks…')
    loading.unmount()
    const { onReload } = view({ status: 'error' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onReload).toHaveBeenCalled()
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
