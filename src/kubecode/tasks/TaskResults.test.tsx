import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError, type KubecodeApi, type TaskDetail } from '../api'
import { useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import { INSPECTOR_PANELS, type InspectorPanelProps } from '../app/inspector/inspectorPanels'
import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import type { InspectorEntry } from '../app/location/inspector'
import { evidenceRow, reviewRequest, taskDetail } from './taskFixtures'
import { TaskResults } from './TaskResults'
import { useTaskDetail } from './useTaskDetail'

/** The Task entry as the stack holds it, showing only its results. */
function ResultsProbe({ entry, projectId }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'task' }>>) {
  const { api, connectionState, events } = useInspectorServices()
  const { detail, reload } = useTaskDetail(api, projectId, entry.id, events, connectionState)
  return (
    <InspectorPanel title="Pruning heads">
      {detail && <TaskResults detail={detail} projectId={projectId} onChanged={reload} />}
    </InspectorPanel>
  )
}

const changed = (current: string) => evidenceRow({ status: 'changed', current })

function mount(details: TaskDetail | TaskDetail[], overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}) {
  const queue = Array.isArray(details) ? [...details] : [details]
  const taskDetail = vi.fn().mockImplementation(() => Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]))
  const api = {
    taskDetail,
    reviewTask: vi.fn().mockResolvedValue({ id: 'v1', accepted: false, general_message_id: 'gm1' }),
    repinTaskEvidence: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue({ content: 'accuracy,0.50', revision: 'b', path: 'results.csv' }),
    ...overrides,
  } as unknown as KubecodeApi
  const navigation = fakeNavigation()
  renderInspector({
    navigation,
    panels: { ...INSPECTOR_PANELS, task: ResultsProbe },
    services: fakeServices({ api }),
    stack: [{ kind: 'task', id: 'r1' }],
  })
  return { api, navigation, taskDetail }
}

const review = () => within(screen.getByRole('region', { name: 'Results for your review' }))
const acceptShown = () => screen.getByRole('button', { name: 'Accept the version you saw' })
const lookAt = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Look at it' }))
  return screen.findByRole('complementary', { name: 'Evidence details' })
}
const backToTask = () => fireEvent.click(screen.getByRole('button', { name: 'Back to Pruning heads' }))

describe('TaskResults', () => {
  it('never accepts a version whose read failed: the button stays disabled and says why', async () => {
    const { api } = mount(taskDetail({ evidence: [changed('b')] }), {
      readFile: vi.fn().mockRejectedValue(new ApiError('internal', 'x', 500)),
    })
    expect(await screen.findByText('Changed since cited')).toBeInTheDocument()
    expect(acceptShown()).toBeDisabled()
    const evidence = await lookAt()
    expect(await within(evidence).findByRole('alert')).toHaveTextContent('Could not load this record.')
    backToTask()
    expect(screen.getByRole('button', { name: 'Look at it' })).toHaveFocus()
    expect(acceptShown()).toBeDisabled()
    expect(acceptShown()).toHaveAccessibleDescription(/A read that failed does not count/)
    expect(api.repinTaskEvidence).not.toHaveBeenCalled()
  })

  it('accepts the version that was displayed, moving every pin of it to exactly that version', async () => {
    const { api } = mount(taskDetail({ evidence: [changed('b')] }))
    await lookAt()
    expect(await screen.findByText('Showing version b')).toBeInTheDocument()
    backToTask()
    expect(screen.getByText('You saw version b.')).toBeInTheDocument()
    fireEvent.click(acceptShown())
    await waitFor(() => expect(api.repinTaskEvidence).toHaveBeenCalledTimes(2))
    expect(api.repinTaskEvidence).toHaveBeenCalledWith('p1', 'r1', expect.objectContaining({ work_id: 'w1', result_id: 'res1' }), 'b')
    expect(api.repinTaskEvidence).toHaveBeenCalledWith('p1', 'r1', expect.objectContaining({ request_id: 'rq1', result_id: 'file:results.csv' }), 'b')
  })

  it('reloads once when the record changed after the list loaded, then accepts the version that was shown', async () => {
    const { api, taskDetail: load } = mount(
      [taskDetail({ evidence: [changed('b')] }), taskDetail({ evidence: [changed('c')] })],
      { readFile: vi.fn().mockResolvedValue({ content: 'accuracy,0.40', revision: 'c', path: 'results.csv' }) },
    )
    await lookAt()
    await screen.findByText('Showing version c')
    backToTask()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(acceptShown()).toBeEnabled())
    expect(load).toHaveBeenCalledTimes(2)
    fireEvent.click(acceptShown())
    await waitFor(() => expect(api.repinTaskEvidence).toHaveBeenCalledWith('p1', 'r1', expect.anything(), 'c'))
  })

  it('accepts a valid negative result once what it showed is chosen', async () => {
    const { api } = mount(taskDetail())
    const accept = await screen.findByRole('button', { name: 'Accept results' })
    expect(accept).toBeDisabled()
    expect(accept).toHaveAccessibleDescription('Choose what the result showed.')
    fireEvent.click(review().getByRole('radio', { name: 'Valid negative result' }))
    expect(accept).toBeEnabled()
    fireEvent.click(accept)
    await waitFor(() => expect(api.reviewTask).toHaveBeenCalledWith('p1', 'r1', {
      requestId: 'rq1', accept: true, outcome: 'refuted', reason: undefined,
    }))
  })

  it('sends work back only with feedback, says General was told, and shows that message in General for this Task', async () => {
    const { api, navigation } = mount(taskDetail())
    const sendBack = await screen.findByRole('button', { name: 'Send back' })
    expect(sendBack).toHaveAccessibleDescription('Say what needs to change.')
    fireEvent.change(screen.getByLabelText('Feedback for the team'), { target: { value: 'Rerun at the new baseline.' } })
    fireEvent.click(sendBack)
    await waitFor(() => expect(api.reviewTask).toHaveBeenCalledWith('p1', 'r1', {
      requestId: 'rq1', accept: false, reason: 'Rerun at the new baseline.',
    }))
    const status = await screen.findByText(/Sent back. The General Agent was told in General/)
    await waitFor(() => expect(status).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Show in General' }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', filter: 'r1', message: 'gm1', thread: null },
      { inspector: 'keep' },
    )
  })

  it('reloads and says so when the server refuses over changed evidence or a review that moved', async () => {
    const { taskDetail: load } = mount(taskDetail(), {
      reviewTask: vi.fn()
        .mockRejectedValueOnce(new ApiError('work_evidence_stale', 'x', 409))
        .mockRejectedValueOnce(new ApiError('task_state', 'x', 409)),
    })
    fireEvent.click(await screen.findByRole('radio', { name: 'Supports the hypothesis' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept results' }))
    expect(await screen.findByText(/The evidence changed while you were reviewing/)).toBeInTheDocument()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Accept results' }))
    expect(await screen.findByText(/This review was already decided or replaced/)).toBeInTheDocument()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3))
  })

  it('accepts without evidence that is gone only after the researcher says they know', async () => {
    mount(taskDetail({ evidence: [evidenceRow({ status: 'removed', current: null })] }))
    expect(await screen.findByText('No longer exists')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Inconclusive' }))
    const accept = screen.getByRole('button', { name: 'Accept results' })
    expect(accept).toHaveAccessibleDescription(/Confirm that you accept the results without the missing evidence/)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(accept).toBeEnabled()
  })

  it('keeps the outcome and feedback across a look at the evidence', async () => {
    mount(taskDetail({ evidence: [changed('b')] }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Inconclusive' }))
    fireEvent.change(screen.getByLabelText('Feedback for the team'), { target: { value: 'half a thought' } })
    await lookAt()
    backToTask()
    expect(screen.getByRole('radio', { name: 'Inconclusive' })).toBeChecked()
    expect(screen.getByLabelText('Feedback for the team')).toHaveValue('half a thought')
  })

  it('shows a Done Task\'s outcome and the evidence that was accepted, with no decision to make', async () => {
    const { navigation } = mount(taskDetail({
      stage: 'done',
      outcome: 'refuted',
      review_requested: false,
      review_requests: [reviewRequest({ state: 'accepted' })],
      reviews: [{
        id: 'v1', research_id: 'r1', request_id: 'rq1', accepted: true, outcome: 'refuted',
        reason: 'Holds at the baseline.', brief_revision: 1, created_at: '2026-10-20 11:00:00', general_message_id: 'gm1',
      }],
      evidence: [evidenceRow({ in_review: false, accepted: true })],
    }))
    const accepted = await screen.findByRole('list', { name: 'Evidence you accepted' })
    expect(within(accepted).getByRole('button', { name: /results\.csv/ })).toBeInTheDocument()
    expect(screen.getAllByText('Valid negative result').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Holds at the baseline.').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Accept results' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send back' })).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Show in General' })[0])
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', filter: 'r1', message: 'gm1', thread: null },
      { inspector: 'keep' },
    )
  })

  it('says when there is nothing to review yet', async () => {
    mount(taskDetail({ stage: 'in_progress', review_requests: [], evidence: [] }))
    expect(await screen.findByText(/No results yet/)).toBeInTheDocument()
  })
})
