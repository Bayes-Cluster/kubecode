import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError, type KubecodeApi, type TaskDetail } from '../api'
import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import type { AttentionStore } from '../attention/attentionContext'
import { attentionStore, execution, permissionItem, routeDelivery, snapshot } from '../attention/attentionFixtures'
import { taskDetail } from './taskFixtures'

vi.mock('../research/ResearchFindingsPanel', () => ({ ResearchFindingsPanel: () => <p>findings panel</p> }))

const question = {
  id: 'dq1', work_id: 'w1', question: 'Which ratios?', options: [], impact: null, asked_by: 's-a',
  state: 'open' as const, answer: null, created_at: '', work_title: 'Sweep',
}

function mount(detail: TaskDetail, attention: AttentionStore | null, overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}) {
  const api = {
    taskDetail: vi.fn().mockResolvedValue(detail),
    answerWorkDecision: vi.fn().mockResolvedValue(undefined),
    reviewTask: vi.fn().mockResolvedValue({ general_message_id: null }),
    setRoundExecutionPolicy: vi.fn().mockResolvedValue(undefined),
    retryRoute: vi.fn().mockResolvedValue({ route: { id: 'route1', state: 'pending' }, retried: true, delivery: null }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    getResearch: vi.fn().mockResolvedValue({ id: 'r1', brief: detail.brief }),
    listResearchEntries: vi.fn().mockResolvedValue([]),
    listResearchFindings: vi.fn().mockResolvedValue([]),
    listResearchOutcomes: vi.fn().mockResolvedValue([]),
    listResearchProposals: vi.fn().mockResolvedValue([]),
    listResearchRounds: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as KubecodeApi
  const navigation = fakeNavigation()
  renderInspector({ attention, navigation, services: fakeServices({ api }), stack: [{ kind: 'task', id: 'r1' }] })
  return { api, navigation }
}

const panel = () => within(screen.getByRole('complementary', { name: 'Task details' }))
const executing = { round_id: 'round1', round_number: 2, paused: false, policy_revision: 3 }

describe('TaskPanel and what waits on the researcher (ADR 0232)', () => {
  it('gives a question and the review the keys Needs you focuses, and answers through the attention store', async () => {
    const store = attentionStore()
    const { api } = mount(taskDetail({ stage: 'in_progress', review_requests: [], pending: [], open_questions: [question] }), store)
    const asked = await panel().findByText('Which ratios?')
    expect(asked.closest('[data-focus-key]')).toHaveAttribute('data-focus-key', 'question:dq1')
    fireEvent.change(panel().getByRole('textbox', { name: 'Your answer' }), { target: { value: '0.5' } })
    fireEvent.click(panel().getByRole('button', { name: 'Answer' }))
    await waitFor(() => expect(api.answerWorkDecision).toHaveBeenCalledWith('p1', 'w1', 'dq1', '0.5'))
    expect(store.markResolving).toHaveBeenCalledWith('question:dq1', expect.any(Function))
  })

  it('gives a revised brief awaiting approval the key Needs you focuses', async () => {
    mount(taskDetail({ stage: 'in_progress', review_requests: [], pending: [], revision: 3, approved_revision: 2 }), attentionStore())
    const line = await panel().findByText(/The brief changed after you approved it/)
    expect(line.closest('[data-focus-key]')).toHaveAttribute('data-focus-key', 'brief:r1:3')
  })

  it('records a review decision through the attention store, on the region Needs you focuses', async () => {
    const store = attentionStore()
    const { api } = mount(taskDetail(), store)
    const region = await panel().findByRole('region', { name: 'Results for your review' })
    expect(region).toHaveAttribute('data-focus-key', 'review:rq1')
    fireEvent.change(within(region).getByRole('textbox', { name: /feedback|reason/i }), { target: { value: 'redo it' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Send back' }))
    await waitFor(() => expect(api.reviewTask).toHaveBeenCalled())
    expect(store.markResolving).toHaveBeenCalledWith('review:rq1', expect.any(Function))
  })

  it('pauses new work on the Task by name, and never re-sends when the limits changed elsewhere', async () => {
    const setRoundExecutionPolicy = vi.fn().mockRejectedValue(new ApiError('policy_revision_conflict', 'changed', 409))
    const { api } = mount(taskDetail({ stage: 'in_progress', review_requests: [], pending: [], execution: executing }), null, { setRoundExecutionPolicy })
    const pause = await panel().findByRole('button', { name: 'Pause new work on Pruning heads' })
    expect(pause).toHaveAttribute('aria-pressed', 'false')
    expect(panel().getByText(/Running turns and experiments continue/)).toBeInTheDocument()
    fireEvent.click(pause)
    await waitFor(() => expect(setRoundExecutionPolicy).toHaveBeenCalledWith('p1', 'round1', 3, { paused: true }))
    expect(await panel().findByText("The Task's limits changed elsewhere; the current state is shown.")).toBeInTheDocument()
    expect(setRoundExecutionPolicy).toHaveBeenCalledTimes(1)
    expect(api.taskDetail).toHaveBeenCalledTimes(2)
  })

  it('says a member waits for permission on this Task, and shows the one prompt where it is answered', async () => {
    const item = permissionItem({ task: { id: 'r1', title: 'Pruning heads' } })
    const store = attentionStore(snapshot({ items: [item], executions: [execution({ tasks: [{ id: 'r1', title: 'Pruning heads' }], waiting_keys: [item.key] })] }))
    const { navigation } = mount(taskDetail({ stage: 'in_progress', review_requests: [], pending: [] }), store)
    const line = await panel().findByText('Analyst is waiting for your permission', { selector: '.kubecode-task-waiting *' })
    // The Task panel never draws a second prompt.
    expect(screen.queryByTestId('permission-queue-card')).not.toBeInTheDocument()
    fireEvent.click(within(line.closest('.kubecode-task-waiting') as HTMLElement).getByRole('button', { name: 'Show' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'general' }, { inspect: { kind: 'task', id: 'r1' }, focus: 'permission:q1' })
    // Its work can be stopped from here, by name.
    expect(panel().getByRole('button', { name: "Stop Analyst's current turn" })).toBeInTheDocument()
  })

  it('says a decision did not reach its recipient, and retries it on request', async () => {
    const issue = { source_kind: 'review', source_id: 'rq0', route: routeDelivery({ state: 'failed', retryable: true, recipient: { id: 'g', name: 'Gene', handle: 'general', role: 'general' }, last_error: 'busy' }) }
    const { api } = mount(taskDetail({ stage: 'in_progress', review_requests: [], pending: [], delivery_issues: [issue] }), null)
    expect(await panel().findByText('Your decision did not reach Gene')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(panel().getByRole('button', { name: 'Retry delivery to Gene' }))
    })
    expect(api.retryRoute).toHaveBeenCalledWith('p1', 'route1')
  })

  it('lists an older verdict the Task moved past as superseded, never with Retry', async () => {
    const gene = { id: 'g', name: 'Gene', handle: 'general', role: 'general' }
    const old = { source_kind: 'review', source_id: 'rq0', route: routeDelivery({ route_id: 'old', state: 'failed', retryable: false, superseded: true, recipient: gene }) }
    mount(taskDetail({ stage: 'in_progress', review_requests: [], pending: [], delivery_issues: [old] }), null)
    expect(await panel().findByText('Your earlier decision did not reach Gene; the Task has moved on, so it is not sent late')).toBeInTheDocument()
    expect(panel().queryByRole('button', { name: 'Retry delivery to Gene' })).not.toBeInTheDocument()
  })

  it('says a retry was refused because the Task moved on', async () => {
    const gene = { id: 'g', name: 'Gene', handle: 'general', role: 'general' }
    const issue = { source_kind: 'review', source_id: 'rq0', route: routeDelivery({ state: 'failed', retryable: true, recipient: gene }) }
    const retryRoute = vi.fn().mockRejectedValue(new ApiError('route_superseded', 'moved on', 409))
    mount(taskDetail({ stage: 'in_progress', review_requests: [], pending: [], delivery_issues: [issue] }), null, { retryRoute })
    const retry = await panel().findByRole('button', { name: 'Retry delivery to Gene' })
    await act(async () => {
      fireEvent.click(retry)
    })
    expect(await panel().findByRole('alert')).toHaveTextContent('The Task has moved on since this decision; it is not sent late.')
  })
})
