import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceEvent } from '../api'
import {
  envelopeFixture,
  executionFixture,
  experimentFixture,
  fakeApi,
  roundFixture,
} from './researchFixtures'
import {
  ResearchExecutionSection,
  type ResearchExecutionSectionProps,
} from './ResearchExecutionSection'

const t = ((key: string, values?: Record<string, unknown>) => (
  values ? `${key} ${JSON.stringify(values)}` : key
)) as never

function mount(overrides: Partial<ResearchExecutionSectionProps> = {}) {
  const props: ResearchExecutionSectionProps = {
    api: fakeApi(),
    archived: false,
    connectionState: 'live',
    events: [],
    projectId: 'p1',
    researchId: 'rq-1',
    round: roundFixture,
    t,
    teams: [],
    ...overrides,
  }
  const view = render(<ResearchExecutionSection {...props} />)
  return { ...view, props }
}

const event = (id: number, kind: string, payload: Record<string, unknown> = {}): WorkspaceEvent => ({
  id, kind, project_id: 'p1', conversation_id: null, run_id: null, payload, created_at: '',
})

describe('ResearchExecutionSection', () => {
  it('loads, then shows the envelope facts and what is enforced', async () => {
    mount()
    expect(screen.getByRole('status')).toHaveTextContent('kubecode.research.exec.loading')
    expect(await screen.findByText('kubecode.research.exec.title')).toBeInTheDocument()
    expect(screen.getByText('1 / 4')).toBeInTheDocument() // launches used
    expect(screen.getByText('python3 train.py')).toBeInTheDocument()
    expect(screen.getByText('bash scripts/eval.sh')).toBeInTheDocument()
    expect(screen.getByText('kubecode.research.exec.envelopeState.active')).toBeInTheDocument()
  })

  it('offers retry on a failed load', async () => {
    const getResearchExecution = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(executionFixture())
    mount({ api: fakeApi({ getResearchExecution }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.research.exec.loadFailed')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.retry' }))
    expect(await screen.findByText('kubecode.research.exec.title')).toBeInTheDocument()
  })

  it('never presents a finished process as analyzed until it is', async () => {
    mount({
      api: fakeApi({
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({
          experiments: [
            experimentFixture({ id: 'x-run', label: 'running one', state: 'running', analysis: 'none', exit_code: null }),
            experimentFixture({ id: 'x-done', label: 'finished one', analysis: 'pending' }),
            experimentFixture({ id: 'x-ok', label: 'settled one', analysis: 'analyzed' }),
          ],
        })),
      }),
    })
    await screen.findByText('kubecode.research.exec.title')
    const card = (name: string) => screen.getByText(name).closest('li')!
    expect(within(card('running one')).getByText('kubecode.research.exec.notYetAnalyzable')).toBeInTheDocument()
    expect(within(card('finished one')).getByText('kubecode.research.exec.awaitingAnalysis')).toBeInTheDocument()
    expect(within(card('settled one')).getByText('kubecode.research.exec.analyzed')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('"count":2') // two results still owed
  })

  it('shows artifact availability, the policy revision, and the Leader\'s decisions', async () => {
    mount({
      api: fakeApi({
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({
          decisions: [{
            id: 'd-1', experiment_id: 'x-1', member_id: 'member-1', kind: 'follow_up',
            decision_key: 'follow_up', rationale: 'Baseline held; widen the search',
            evidence: [], launched_experiment_id: 'x-2', created_at: '',
          }],
        })),
      }),
    })
    const card = (await screen.findByText('baseline')).closest('li')!
    expect(within(card).getByText('kubecode.research.availability.changed')).toBeInTheDocument()
    expect(within(card).getByText(/exec\.policyRevision/)).toHaveTextContent('"revision":2')
    expect(within(card).getByText('kubecode.research.exec.decision.followUp')).toBeInTheDocument()
    expect(within(card).getByText(/widen the search/)).toBeInTheDocument()
  })

  it('lists why another launch would be refused', async () => {
    mount({
      api: fakeApi({
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({
          launch_blockers: ['launch_budget_exhausted', 'no_progress'],
        })),
      }),
    })
    const list = await screen.findByRole('list', { name: 'kubecode.research.exec.attention' })
    expect(within(list).getByText('kubecode.research.exec.blocker.budget')).toBeInTheDocument()
    expect(within(list).getByText('kubecode.research.exec.blocker.noProgress')).toBeInTheDocument()
  })

  it('pauses and resumes future launches and says running work is untouched', async () => {
    const setResearchExecutionState = vi.fn().mockResolvedValue(envelopeFixture)
    const paused = executionFixture({ envelope: { ...envelopeFixture, state: 'paused' } })
    const getResearchExecution = vi.fn().mockResolvedValueOnce(executionFixture()).mockResolvedValue(paused)
    mount({ api: fakeApi({ setResearchExecutionState, getResearchExecution }) })
    expect(await screen.findByText('kubecode.research.exec.pauseHint')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.exec.pause' }))
    await waitFor(() => expect(setResearchExecutionState).toHaveBeenCalledWith('p1', 'rq-1', 'round-1', 'pause'))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.exec.resume' }))
    await waitFor(() => expect(setResearchExecutionState).toHaveBeenCalledWith('p1', 'rq-1', 'round-1', 'resume'))
  })

  it('cancels the whole round only after an explicit confirmation', async () => {
    const cancelResearchExecution = vi.fn().mockResolvedValue({ cancelled: 1, envelope: envelopeFixture })
    mount({
      api: fakeApi({
        cancelResearchExecution,
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({
          experiments: [experimentFixture({ state: 'running', analysis: 'none' })],
        })),
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.exec.cancelAll' }))
    expect(cancelResearchExecution).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('"count":1')
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.research.exec.keepRunning' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(cancelResearchExecution).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.exec.cancelAll' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'kubecode.research.exec.cancelAllYes' }))
    await waitFor(() => expect(cancelResearchExecution).toHaveBeenCalledWith('p1', 'rq-1', 'round-1'))
  })

  it('stops one running process but offers nothing for a finished or stopping one', async () => {
    const cancelExperiment = vi.fn().mockResolvedValue(experimentFixture())
    mount({
      api: fakeApi({
        cancelExperiment,
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({
          experiments: [
            experimentFixture({ id: 'x-run', label: 'live', state: 'running', analysis: 'none' }),
            experimentFixture({ id: 'x-stopping', label: 'stopping', state: 'cancelling', analysis: 'none', cancel_requested: true }),
            experimentFixture({ id: 'x-done', label: 'done' }),
          ],
        })),
      }),
    })
    await screen.findByText('live')
    const stops = screen.getAllByRole('button', { name: /kubecode.research.exec.stop/ })
    expect(stops).toHaveLength(1)
    fireEvent.click(stops[0])
    await waitFor(() => expect(cancelExperiment).toHaveBeenCalledWith('p1', 'rq-1', 'x-run'))
  })

  it('makes an unknown outcome visible and reconciles only on the researcher\'s word', async () => {
    const reconcileExperiment = vi.fn().mockResolvedValue(experimentFixture())
    mount({
      api: fakeApi({
        reconcileExperiment,
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({
          experiments: [experimentFixture({ state: 'unknown', exit_code: null, reason: 'lost', analysis: 'pending' })],
        })),
      }),
    })
    const group = await screen.findByRole('group', { name: 'kubecode.research.exec.reconcile' })
    expect(within(group).getByText('kubecode.research.exec.unknownHint')).toBeInTheDocument()
    fireEvent.change(within(group).getByLabelText('kubecode.research.exec.exitCodeOptional'), { target: { value: '0' } })
    fireEvent.click(within(group).getByRole('button', { name: 'kubecode.research.exec.didFinish' }))
    await waitFor(() => expect(reconcileExperiment).toHaveBeenCalledWith('p1', 'rq-1', 'x-1', 'finished', 0))
    fireEvent.click(within(group).getByRole('button', { name: 'kubecode.research.exec.neverStarted' }))
    await waitFor(() => expect(reconcileExperiment).toHaveBeenCalledWith('p1', 'rq-1', 'x-1', 'not_started', 0))
  })

  it('loads a bounded output tail on demand and says when it was cut', async () => {
    const getExperimentLog = vi.fn().mockImplementation(async (_p, _r, _e, stream) => (
      stream === 'stdout'
        ? { text: 'epoch 9 loss 0.1', total_bytes: 900_000, truncated: true }
        : { text: '', total_bytes: 0, truncated: false }
    ))
    mount({ api: fakeApi({ getExperimentLog }) })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.exec.viewOutput' }))
    expect(await screen.findByText('epoch 9 loss 0.1')).toBeInTheDocument()
    expect(screen.getByText('kubecode.research.exec.emptyOutput')).toBeInTheDocument()
    expect(screen.getByText(/kubecode.research.exec.truncated/)).toHaveTextContent('900000')
  })

  it('shows who waits for a result and until when', async () => {
    mount({
      api: fakeApi({
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({
          experiments: [experimentFixture({ state: 'running', analysis: 'none' })],
          waits: [{
            id: 'w-1', experiment_id: 'x-1', team_id: 't-1', task_id: null, attempt_id: null,
            owner_member_id: 'member-1', expected_follow_up: 'compare to the baseline',
            deadline_at: 1_800_003_600, state: 'open', created_at: '', resolved_at: null,
          }],
        })),
      }),
      teams: [{
        team: { id: 't-1' },
        members: [{ id: 'member-1', name: 'Mira' }],
      }] as never,
    })
    expect(await screen.findByText(/Mira/)).toHaveTextContent('compare to the baseline')
  })

  it('sets up an envelope for a round that has none, validating before sending', async () => {
    const setResearchEnvelope = vi.fn().mockResolvedValue(envelopeFixture)
    mount({
      api: fakeApi({
        setResearchEnvelope,
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({ envelope: null, experiments: [] })),
      }),
    })
    expect(await screen.findByText('kubecode.research.exec.noEnvelope')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.exec.setUp' }))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.exec.saveEnvelope' }))
    expect(await screen.findByText('kubecode.research.exec.invalid')).toBeInTheDocument()
    expect(setResearchEnvelope).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('kubecode.research.exec.allowedCommands'), { target: { value: 'python3 train.py' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.exec.saveEnvelope' }))
    await waitFor(() => expect(setResearchEnvelope).toHaveBeenCalledTimes(1))
    const [, , , limits, expected] = setResearchEnvelope.mock.calls[0]
    expect(limits.allowed_commands).toEqual([['python3', 'train.py']])
    expect(expected).toBeUndefined()
  })

  it('revises an envelope against the revision it was looking at and keeps the deadline', async () => {
    const withDeadline = {
      ...envelopeFixture,
      limits: { ...envelopeFixture.limits, deadline_at: 1_800_007_200 },
    }
    const setResearchEnvelope = vi.fn().mockResolvedValue(withDeadline)
    mount({
      api: fakeApi({
        setResearchEnvelope,
        getResearchExecution: vi.fn().mockResolvedValue(executionFixture({ envelope: withDeadline })),
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.exec.editEnvelope' }))
    fireEvent.change(screen.getByLabelText('kubecode.research.exec.maxLaunches'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.exec.saveEnvelope' }))
    await waitFor(() => expect(setResearchEnvelope).toHaveBeenCalledTimes(1))
    const [, , , limits, expected] = setResearchEnvelope.mock.calls[0]
    expect(expected).toBe(2)
    expect(limits).toMatchObject({ max_launches: 6, deadline_at: 1_800_007_200 })
  })

  it('hides setup and edit controls for an archived question but keeps safety controls', async () => {
    mount({ archived: true })
    await screen.findByText('kubecode.research.exec.title')
    expect(screen.queryByRole('button', { name: 'kubecode.research.exec.editEnvelope' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'kubecode.research.exec.pause' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'kubecode.research.exec.cancelAll' })).toBeInTheDocument()
  })

  it('reconciles after its question\'s events and a reconnect, and keeps showing stale data on failure', async () => {
    const getResearchExecution = vi.fn().mockResolvedValue(executionFixture())
    const api = fakeApi({ getResearchExecution })
    const props: ResearchExecutionSectionProps = {
      api, archived: false, connectionState: 'live', events: [], projectId: 'p1',
      researchId: 'rq-1', round: roundFixture, t, teams: [],
    }
    const view = render(<ResearchExecutionSection {...props} />)
    await screen.findByText('kubecode.research.exec.title')
    const initial = getResearchExecution.mock.calls.length

    await act(async () => {
      view.rerender(<ResearchExecutionSection {...props} events={[event(1, 'research_updated', { research_id: 'other' })]} />)
    })
    expect(getResearchExecution.mock.calls.length).toBe(initial)

    getResearchExecution.mockRejectedValue(new Error('down'))
    await act(async () => {
      view.rerender(<ResearchExecutionSection {...props} events={[event(2, 'research_updated', { research_id: 'rq-1' })]} />)
    })
    await waitFor(() => expect(getResearchExecution.mock.calls.length).toBe(initial + 1))
    // The last known state stays visible, marked as stale.
    expect(await screen.findByText('kubecode.research.exec.stale')).toBeInTheDocument()
    expect(screen.getByText('python3 train.py')).toBeInTheDocument()

    getResearchExecution.mockResolvedValue(executionFixture())
    await act(async () => {
      view.rerender(<ResearchExecutionSection {...props} connectionState="reconnecting" events={[event(2, 'research_updated', { research_id: 'rq-1' })]} />)
    })
    await act(async () => {
      view.rerender(<ResearchExecutionSection {...props} connectionState="live" events={[event(2, 'research_updated', { research_id: 'rq-1' })]} />)
    })
    await waitFor(() => expect(screen.queryByText('kubecode.research.exec.stale')).not.toBeInTheDocument())
  })
})
