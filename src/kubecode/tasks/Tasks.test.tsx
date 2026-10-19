import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, TaskBoard, TaskCard, TaskDetail, TaskDraft } from '../api'
import { ApiError } from '../api'
import { TaskBoardView } from './TaskBoardView'
import { TaskInspector } from './TaskInspector'

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
        onClose={vi.fn()}
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
        onClose={vi.fn()}
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

function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...card({ stage: 'review', review_requested: true }),
    brief: { title: 'Pruning', question: '?', motivation: '', hypotheses: [], constraints: [], evaluation_criteria: [] },
    revisions: [], authorizing_message: { id: 'm1', body: 'please add it', created_at: '' },
    review_requests: [{
      id: 'rq1', research_id: 'r1', summary: 'Accuracy held at 0.91', evidence: ['artifact:results.csv'],
      requested_by: 's', brief_revision: 1, state: 'open', created_at: '', resolved_at: null,
    }],
    reviews: [], internal_work: [], open_questions: [], stale_evidence: [], ...overrides,
  } as TaskDetail
}

function inspector(value: TaskDetail | null, overrides: Record<string, unknown> = {}) {
  const api = {
    taskDetail: vi.fn().mockResolvedValue(value),
    reviewTask: vi.fn().mockResolvedValue({}),
    repinTaskEvidence: vi.fn().mockResolvedValue(undefined),
    answerWorkDecision: vi.fn().mockResolvedValue(undefined),
    readProjectContext: vi.fn().mockRejectedValue(new Error('not needed')),
    ...overrides,
  } as unknown as KubecodeApi
  if (value === null) {
    (api.taskDetail as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError('task_not_found', 'x', 404))
  }
  const onShowMessage = vi.fn()
  render(
    <TaskInspector api={api} connectionState="live" events={[]} projectId="p1" t={t} taskId="r1" onShowMessage={onShowMessage} />,
  )
  return { api, onShowMessage }
}

describe('TaskInspector', () => {
  it('says a proposal is not on the board and where to put it there', async () => {
    inspector(null)
    expect(await screen.findByText('kubecode.task.notOnBoard')).toBeInTheDocument()
  })

  it('shows the authorization, a stale approval, and who works on it', async () => {
    const { onShowMessage } = inspector(detail({ revision: 3, approved_revision: 2 }))
    expect(await screen.findByText('please add it')).toBeInTheDocument()
    expect(screen.getByText('kubecode.task.staleApproval:{"approved":2}')).toBeInTheDocument()
    expect(screen.getByText('kubecode.task.revisions:{"revision":3,"approved":2}')).toBeInTheDocument()
    expect(screen.getByText('kubecode.task.manager')).toBeInTheDocument()
    expect(screen.getByText('kubecode.task.specialist')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.task.showMessage' }))
    expect(onShowMessage).toHaveBeenCalledWith('m1')
  })

  it('accepts a negative finding with its outcome, and sending back needs a reason', async () => {
    const { api } = inspector(detail())
    await screen.findByText('Accuracy held at 0.91')
    const accept = screen.getByRole('button', { name: 'kubecode.task.acceptResults' })
    const sendBack = screen.getByRole('button', { name: 'kubecode.task.sendBack' })
    expect(accept).toBeDisabled()
    expect(sendBack).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'refuted' } })
    expect(accept).toBeEnabled()
    fireEvent.change(screen.getByLabelText('kubecode.task.reason'), { target: { value: 'pruning hurts accuracy' } })
    fireEvent.click(accept)
    await waitFor(() => expect(api.reviewTask).toHaveBeenCalledWith('p1', 'r1', {
      requestId: 'rq1', accept: true, outcome: 'refuted', reason: 'pruning hurts accuracy',
    }))
    fireEvent.click(sendBack)
    await waitFor(() => expect(api.reviewTask).toHaveBeenLastCalledWith('p1', 'r1', {
      requestId: 'rq1', accept: false, reason: 'pruning hurts accuracy',
    }))
  })

  it('refuses to accept while evidence changed, and re-pins only after it was looked at, at the version looked at', async () => {
    const { api } = inspector(detail({
      stale_evidence: [
        { work_id: 'w1', result_id: 'res1', kind: 'artifact', ref_id: 'results.csv', status: 'changed', pinned: 'a', current: 'b' },
      ],
    }), { readProjectContext: vi.fn().mockResolvedValue({
      ref: { kind: 'artifact', id: 'results.csv', revision: 'b' }, availability: 'changed', sections: [], notes: [], related: [],
    }) })
    await screen.findByText('kubecode.task.staleEvidenceTitle')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'supported' } })
    expect(screen.getByRole('button', { name: 'kubecode.task.acceptResults' })).toBeDisabled()
    // Accepting the current version is not possible before it was looked at.
    const accept = screen.getByRole('button', { name: 'kubecode.task.acceptCurrent' })
    expect(accept).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.task.lookAtIt' }))
    expect(accept).toBeEnabled()
    fireEvent.click(accept)
    await waitFor(() => expect(api.repinTaskEvidence).toHaveBeenCalledWith('p1', 'r1', 'w1', 'res1', 'b'))
  })

  it('lets the researcher accept results when evidence no longer exists, only after saying they know', async () => {
    const { api } = inspector(detail({
      stale_evidence: [
        { work_id: 'w1', result_id: 'res2', kind: 'artifact', ref_id: 'gone.csv', status: 'removed', pinned: 'a', current: null },
      ],
    }))
    await screen.findByText('kubecode.task.staleEvidenceTitle')
    expect(screen.queryByRole('button', { name: 'kubecode.task.acceptCurrent' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'refuted' } })
    const accept = screen.getByRole('button', { name: 'kubecode.task.acceptResults' })
    expect(accept).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(accept).toBeEnabled()
    fireEvent.click(accept)
    await waitFor(() => expect(api.reviewTask).toHaveBeenCalled())
  })

  it('reloads and says so when the server refuses an acceptance over changed evidence', async () => {
    const reviewTask = vi.fn().mockRejectedValue(new ApiError('work_evidence_stale', 'x', 409))
    const { api } = inspector(detail(), { reviewTask })
    await screen.findByText('Accuracy held at 0.91')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'supported' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.task.acceptResults' }))
    expect(await screen.findByText('kubecode.task.evidenceStale')).toBeInTheDocument()
    await waitFor(() => expect((api.taskDetail as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1))
  })

  it('shows requests for input with their options and answers them in place', async () => {
    const { api } = inspector(detail({
      review_requests: [],
      open_questions: [{
        id: 'q1', work_id: 'w1', work_title: 'Sweep', question: 'Which ratio?', options: ['0.3', '0.5'],
        impact: 'decides the sweep', asked_by: 's', state: 'open', answer: null, created_at: '',
      }],
    }))
    expect(await screen.findByText('Which ratio?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '0.5' }))
    await waitFor(() => expect(api.answerWorkDecision).toHaveBeenCalledWith('p1', 'w1', 'q1', '0.5'))
  })
})
