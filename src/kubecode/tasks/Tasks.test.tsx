import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TaskBoard, TaskCard, TaskDraft } from '../api'
import { createPlaceMemory, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { nextFrame, stubScrollGeometry } from '@/test/scrollGeometry'
import { TaskBoardView } from './TaskBoardView'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const card = (overrides: Partial<TaskCard>): TaskCard => ({
  id: 'r1', project_id: 'p1', title: 'Pruning', question: '?', stage: 'ready', condition: 'none',
  condition_reason: null, revision: 1, approved_revision: 1, admitted_at: '', origin: 'conversation',
  authorizing_message_id: 'm1',
  participants: [
    { member_id: 'g', name: 'General', handle: 'general', role: 'general' },
    { member_id: 'a', name: 'Analyst', handle: 'analyst', role: 'specialist' },
  ],
  open_questions: 0, review_requested: false, updated_at: '', ...overrides,
})

const board = (cards: TaskCard[]): TaskBoard => ({ cards, stages: [], total: cards.length })

describe('TaskBoardView', () => {
  it('shows only the four stages, conditions on cards (never columns), and who manages and who executes', () => {
    const onOpenTask = vi.fn()
    render(
      <TaskBoardView
        board={board([
          card({ id: 'r1', title: 'Ready one' }),
          card({ id: 'r2', title: 'Running', stage: 'in_progress', condition: 'blocked', condition_reason: 'needs GPU' }),
          card({ id: 'r3', title: 'Awaiting', stage: 'review', review_requested: true, revision: 3, approved_revision: 2 }),
          card({ id: 'r4', title: 'Finished', stage: 'done' }),
        ])}
        drafts={[]}
        status="ready"
        t={t}
        onOpenDraft={vi.fn()}
        onOpenTask={onOpenTask}
        onReload={vi.fn()}
      />,
    )
    const columns = screen.getAllByRole('region').filter((region) => region.hasAttribute('data-stage'))
    expect(columns.map((column) => column.getAttribute('data-stage'))).toEqual(['ready', 'in_progress', 'review', 'done'])
    const running = within(screen.getByRole('region', { name: 'kubecode.task.stage.in_progress' }))
    expect(running.getByText('Running')).toBeInTheDocument()
    expect(running.getByText('kubecode.work.condition.blocked')).toHaveAttribute('title', 'needs GPU')
    const review = within(screen.getByRole('region', { name: 'kubecode.task.stage.review' }))
    expect(review.getByText('kubecode.task.awaitingYou')).toBeInTheDocument()
    expect(review.getByText('kubecode.task.briefChanged')).toBeInTheDocument()
    expect(screen.getAllByText(/kubecode\.task\.manager: @general/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('task-card-r4'))
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'r4' }))
  })

  it('lists proposals apart from the board, loads, retries, and has no way to admit anything', () => {
    const drafts: TaskDraft[] = [{
      id: 'd1', project_id: 'p1', title: 'Quantize', question: '?', revision: 2, proposed_by: 'agent', updated_at: '',
    }]
    const onOpenDraft = vi.fn()
    const onReload = vi.fn()
    render(
      <TaskBoardView
        board={null}
        drafts={drafts}
        status="error"
        t={t}
        onOpenDraft={onOpenDraft}
        onOpenTask={vi.fn()}
        onReload={onReload}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.retry' }))
    expect(onReload).toHaveBeenCalled()
    fireEvent.click(screen.getByText('kubecode.task.proposals:{"count":1}'))
    fireEvent.click(screen.getByRole('button', { name: /Quantize/ }))
    expect(onOpenDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }))
    expect(screen.queryByRole('button', { name: /add|admit|confirm/i })).not.toBeInTheDocument()
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
        onOpenDraft={vi.fn()}
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
      const scroller = screen.getByRole('region', { name: 'kubecode.nav.board' })
      scroller.scrollTop = 130
      fireEvent.scroll(scroller)
      await act(nextFrame)

      view.rerender(<PlaceMemoryProvider memory={memory}><p>General</p></PlaceMemoryProvider>)
      view.rerender(boardIn(memory, null))
      const again = screen.getByRole('region', { name: 'kubecode.nav.board' })
      expect(again.scrollTop).toBe(0)
      view.rerender(boardIn(memory, cards))
      expect(again.scrollTop).toBe(130)
    } finally {
      restore()
    }
  })
})
