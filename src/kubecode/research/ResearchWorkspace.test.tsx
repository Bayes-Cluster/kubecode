import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api'
import type { WorkspaceEvent } from '../api'
import {
  detailFixture,
  entryFixture,
  fakeApi,
  findingFixture,
  roundFixture,
} from './researchFixtures'
import { ResearchWorkspace, type ResearchWorkspaceProps } from './ResearchWorkspace'

const t = ((key: string, values?: Record<string, unknown>) => (
  values ? `${key} ${JSON.stringify(values)}` : key
)) as never

const agents = [{ id: 'codex', available: true, version: null, executable: 'codex', error: null }] as never

function mount(overrides: Partial<ResearchWorkspaceProps> = {}) {
  const props: ResearchWorkspaceProps = {
    agents,
    api: fakeApi(),
    connectionState: 'live',
    conversations: [],
    events: [],
    onConversationCreated: vi.fn(),
    onOpenSession: vi.fn(),
    projectId: 'p1',
    researchId: 'rq-1',
    t,
    teams: [],
    ...overrides,
  }
  const view = render(<ResearchWorkspace {...props} />)
  return { ...view, props }
}

function openTab(name: string) {
  const tab = screen.getByRole('tab', { name })
  fireEvent.mouseDown(tab, { button: 0 })
}

/** The visible tab panel; panels stay mounted so drafts survive tab switches. */
function panel() {
  return within(screen.getByRole('tabpanel'))
}

function event(id: number, kind: string, payload: Record<string, unknown> = {}): WorkspaceEvent {
  return {
    id, kind, project_id: 'p1', conversation_id: null, run_id: null, payload, created_at: '',
  }
}

describe('ResearchWorkspace', () => {
  it('in the inspector, draws the Back and Close it is given in its one header, and reports its title', async () => {
    const onBack = vi.fn()
    const onCloseDetail = vi.fn()
    const onTitle = vi.fn()
    mount({
      back: { label: 'Back to General', onBack },
      close: { label: 'Close details', onClose: onCloseDetail },
      onTitle,
    })
    // While loading, the way out is already there.
    fireEvent.click(screen.getByRole('button', { name: 'Back to General' }))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Does structured pruning keep accuracy?')).toBeInTheDocument()
    await waitFor(() => expect(onTitle).toHaveBeenCalledWith('Pruning'))
    fireEvent.click(screen.getByRole('button', { name: 'Back to General' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(onBack).toHaveBeenCalledTimes(2)
    expect(onCloseDetail).toHaveBeenCalledTimes(1)
    // No way "back to Sessions" of its own: only the Back and Close it was given.
    expect(screen.getAllByRole('button', { name: /back/i })).toHaveLength(1)
  })

  it('for a Task, shows its stage and the way to it, and nothing that finishes, reopens, archives, or starts it', async () => {
    const onOpen = vi.fn()
    mount({ task: { stage: 'review', archived: false, onOpen } })
    expect(await screen.findByText('Does structured pruning keep accuracy?')).toBeInTheDocument()
    expect(screen.getByText('kubecode.task.stage.review')).toBeInTheDocument()
    expect(screen.queryByText('kubecode.research.status.open')).not.toBeInTheDocument()
    expect(screen.getByText('kubecode.task.isTask')).toBeInTheDocument()
    for (const name of ['kubecode.research.resolve', 'kubecode.research.reopen', 'kubecode.research.archive', 'kubecode.research.restore']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    openTab('kubecode.research.tab.work')
    expect(screen.queryByRole('button', { name: /kubecode.research.startRound/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.task.openTask' }))
    expect(onOpen).toHaveBeenCalled()
  })

  it('says an admitted Task is finished by its review when the server refuses to resolve it', async () => {
    const setResearchState = vi.fn().mockRejectedValue(new ApiError('task_owned', 'x', 409))
    mount({ api: fakeApi({ setResearchState }) })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.resolve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.task.ownedStatus')
  })

  it('shows loading, then the brief with its revision', async () => {
    mount()
    expect(screen.getByRole('status')).toHaveTextContent('kubecode.research.loading')
    expect(await screen.findByText('Does structured pruning keep accuracy?')).toBeInTheDocument()
    expect(screen.getByText('Late layers tolerate pruning')).toBeInTheDocument()
    expect(screen.getAllByText(/kubecode.research.revision /)[0]).toHaveTextContent('"revision":2')
  })

  it('offers retry on a failed load and reports a missing question without retry', async () => {
    const getResearch = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(detailFixture)
    mount({ api: fakeApi({ getResearch }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.research.loadFailed')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.retry' }))
    expect(await screen.findByText('Does structured pruning keep accuracy?')).toBeInTheDocument()

    const gone = vi.fn().mockRejectedValue(new ApiError('research_not_found', 'missing', 404))
    const view = mount({ api: fakeApi({ getResearch: gone }), researchId: 'rq-9' })
    const alerts = await view.findAllByRole('alert')
    expect(alerts.at(-1)).toHaveTextContent('kubecode.research.error.notFound')
    expect(screen.queryAllByRole('button', { name: 'kubecode.retry' })).toHaveLength(0)
  })

  it('saves only the changed field against the revision the edit began from', async () => {
    const updateResearch = vi.fn().mockResolvedValue(detailFixture)
    mount({ api: fakeApi({ updateResearch }) })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.editBrief' }))
    fireEvent.change(screen.getByLabelText('kubecode.research.field.motivation'), {
      target: { value: 'Cheaper and faster inference' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.saveBrief' }))
    await waitFor(() => expect(updateResearch).toHaveBeenCalledTimes(1))
    expect(updateResearch).toHaveBeenCalledWith('p1', 'rq-1', 2, {
      motivation: 'Cheaper and faster inference',
    })
  })

  it('keeps the draft and blocks saving when the brief moved underneath the edit', async () => {
    const updateResearch = vi.fn().mockRejectedValue(
      new ApiError('research_revision_conflict', 'conflict', 409),
    )
    const getResearch = vi.fn().mockResolvedValue(detailFixture)
    mount({ api: fakeApi({ updateResearch, getResearch }) })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.editBrief' }))
    fireEvent.change(screen.getByLabelText('kubecode.research.field.title'), { target: { value: 'New title' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.saveBrief' }))

    expect(await screen.findByText('kubecode.research.error.revisionConflict')).toBeInTheDocument()
    expect(screen.getByLabelText('kubecode.research.field.title')).toHaveValue('New title')
    expect(screen.getByRole('button', { name: 'kubecode.research.saveBrief' })).toBeDisabled()

    const before = getResearch.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.discardAndReload' }))
    await waitFor(() => expect(getResearch.mock.calls.length).toBeGreaterThan(before))
    expect(screen.queryByLabelText('kubecode.research.field.title')).not.toBeInTheDocument()
  })

  it('records a note without starting any work', async () => {
    const addResearchEntry = vi.fn().mockResolvedValue(entryFixture)
    const startResearchRound = vi.fn()
    mount({ api: fakeApi({ addResearchEntry, startResearchRound }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    expect(await panel().findByText('Start with ResNet')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('kubecode.research.entryBody'), { target: { value: 'Try 50% sparsity' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.addEntry' }))
    await waitFor(() => expect(addResearchEntry).toHaveBeenCalledTimes(1))
    expect(addResearchEntry.mock.calls[0].slice(0, 4)).toEqual(['p1', 'rq-1', 'note', 'Try 50% sparsity'])
    expect(startResearchRound).not.toHaveBeenCalled()
  })

  it('opens the one work board filtered to this question from its Work tab', async () => {
    const onOpenBoard = vi.fn()
    mount({ onOpenBoard })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.work.openBoard' }))
    expect(onOpenBoard).toHaveBeenCalledWith({ research_id: 'rq-1' })
  })

  it('opens a linked discussion Session and reports a removed one', async () => {
    const detail = {
      ...detailFixture,
      links: [
        ...detailFixture.links,
        { ...detailFixture.links[0], ref_id: 's-gone', title: 'Old chat', availability: 'removed' as const },
      ],
    }
    const { props } = mount({ api: fakeApi({ getResearch: vi.fn().mockResolvedValue(detail) }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    const list = (await panel().findByText('Pruning chat')).closest('li')!
    fireEvent.click(within(list).getByRole('button', { name: /kubecode.research.openSession/ }))
    expect(props.onOpenSession).toHaveBeenCalledWith('s-1')
    const gone = panel().getByText('Old chat').closest('li')!
    expect(within(gone).getByText('kubecode.research.availability.removed')).toBeInTheDocument()
    expect(within(gone).getByRole('button', { name: /kubecode.research.openSession/ })).toBeDisabled()
  })

  it('shows findings with their basis, stale revision, and evidence state', async () => {
    mount({
      api: fakeApi({
        listResearchFindings: vi.fn().mockResolvedValue([
          findingFixture,
          { ...findingFixture, id: 'f-2', seq: 2, basis: 'interpretation', statement: 'Probably robust', evidence: [], evidence_state: [], stale: false },
        ]),
      }),
    })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.findings')
    const observed = (await screen.findByText('Accuracy held at 0.9')).closest('li')!
    expect(within(observed).getByText('kubecode.research.basis.observation')).toBeInTheDocument()
    expect(within(observed).getByText('kubecode.research.stale')).toBeInTheDocument()
    expect(within(observed).getByText('results.csv')).toBeInTheDocument()
    expect(within(observed).getByText('kubecode.research.availability.changed')).toBeInTheDocument()
    const guessed = screen.getByText('Probably robust').closest('li')!
    expect(within(guessed).getByText('kubecode.research.basis.interpretation')).toBeInTheDocument()
    expect(within(guessed).queryByText('kubecode.research.stale')).not.toBeInTheDocument()
  })

  it('asks for a decision on a proposal and on a Team whose results are not recorded', async () => {
    const reviewResearchProposal = vi.fn().mockResolvedValue({})
    const declineResearchOutcome = vi.fn().mockResolvedValue({})
    mount({
      api: fakeApi({
        reviewResearchProposal,
        declineResearchOutcome,
        listResearchProposals: vi.fn().mockResolvedValue([{
          entry: { ...entryFixture, id: 'e-p', kind: 'proposal', author_kind: 'agent', body: 'Drop single-GPU' },
          review: null,
        }]),
        listResearchOutcomes: vi.fn().mockResolvedValue([{
          team_id: 't-1', research_id: 'rq-1', round_id: 'round-1', status: 'pending',
          publication_id: null, created_at: '', resolved_at: null,
        }]),
      }),
    })
    const banner = await screen.findByRole('button', { name: /kubecode.research.pendingDecisions/ })
    expect(banner).toHaveTextContent('"count":2')
    fireEvent.click(banner)

    expect(await screen.findByText('Drop single-GPU')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /kubecode.research.accept/ }))
    await waitFor(() => expect(reviewResearchProposal).toHaveBeenCalledWith('p1', 'rq-1', 'e-p', 'accepted'))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.nothingToRecord' }))
    await waitFor(() => expect(declineResearchOutcome).toHaveBeenCalledWith('p1', 'rq-1', 't-1'))
  })

  it('records findings from a linked Session with a retry key', async () => {
    const captureResearchFindings = vi.fn().mockResolvedValue({ created: true, findings: [] })
    mount({ api: fakeApi({ captureResearchFindings }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.findings')
    fireEvent.change(await screen.findByLabelText('kubecode.research.statement'), { target: { value: 'It held' } })
    fireEvent.change(screen.getByLabelText('kubecode.research.evidenceFile'), { target: { value: 'out/r.csv' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.record' }))
    await waitFor(() => expect(captureResearchFindings).toHaveBeenCalledTimes(1))
    const [, , request] = captureResearchFindings.mock.calls[0]
    expect(request).toMatchObject({
      session_id: 's-1',
      findings: [{ kind: 'finding', statement: 'It held', evidence: [{ kind: 'file', id: 'out/r.csv' }] }],
    })
    expect(typeof request.publication_key).toBe('string')
  })

  it('shows rounds with their context revision and starts the next one explicitly', async () => {
    const startResearchRound = vi.fn().mockResolvedValue(roundFixture)
    const { props } = mount({
      api: fakeApi({
        startResearchRound,
        listResearchFindings: vi.fn().mockResolvedValue([
          {
            ...findingFixture,
            evidence_state: [
              { kind: 'file', id: 'ok.csv', availability: 'available' },
              { kind: 'file', id: 'moved.csv', availability: 'changed' },
            ],
          },
        ]),
      }),
      teams: [{ team: { id: 't-1' }, leader_conversation: { id: 'lead-1' } }] as never,
    })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    const round = (await screen.findByText('Compare approaches')).closest('li')!
    expect(within(round).getByText(/kubecode.research.contextRevision/)).toHaveTextContent('"revision":1')
    expect(within(round).getByText('kubecode.research.stale')).toBeInTheDocument()
    expect(within(round).getByText('kubecode.research.availability.removed')).toBeInTheDocument()
    fireEvent.click(within(round).getByRole('button', { name: 'kubecode.research.openTeam' }))
    expect(props.onOpenSession).toHaveBeenCalledWith('lead-1')

    // Nothing has started until the researcher asks, and a changed source is
    // never carried forward as if it were still the original evidence.
    expect(startResearchRound).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: /ok.csv/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /moved.csv/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('kubecode.research.instruction'), { target: { value: 'Try 70% sparsity' } })
    fireEvent.click(screen.getByRole('button', { name: /kubecode.research.startRound/ }))
    await waitFor(() => expect(startResearchRound).toHaveBeenCalledTimes(1))
    const [project, research, request] = startResearchRound.mock.calls[0]
    expect([project, research]).toEqual(['p1', 'rq-1'])
    expect(request).toMatchObject({
      expected_revision: 2,
      mode: 'team',
      agent_id: 'codex',
      instruction: 'Try 70% sparsity',
      sources: [{ kind: 'file', id: 'ok.csv' }],
    })
  })

  it('reuses the round key after a failed start and shows the conflict', async () => {
    const startResearchRound = vi.fn()
      .mockRejectedValueOnce(new ApiError('research_revision_conflict', 'moved', 409))
      .mockResolvedValue(roundFixture)
    mount({ api: fakeApi({ startResearchRound }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    const start = await screen.findByRole('button', { name: /kubecode.research.startRound/ })
    fireEvent.click(start)
    expect(await screen.findByText('kubecode.research.error.revisionConflict')).toBeInTheDocument()
    fireEvent.click(start)
    await waitFor(() => expect(startResearchRound).toHaveBeenCalledTimes(2))
    expect(startResearchRound.mock.calls[1][2].client_request_id)
      .toBe(startResearchRound.mock.calls[0][2].client_request_id)
  })

  it('resumes an unfinished round', async () => {
    const resumeResearchRound = vi.fn().mockResolvedValue(roundFixture)
    mount({
      api: fakeApi({
        resumeResearchRound,
        listResearchRounds: vi.fn().mockResolvedValue([{ ...roundFixture, phase: 'team_created' }]),
      }),
    })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.resume' }))
    await waitFor(() => expect(resumeResearchRound).toHaveBeenCalledWith('p1', 'rq-1', 'round-1'))
  })

  it('blocks writes on an archived question and explains why', async () => {
    const archived = { ...detailFixture, archived: true }
    mount({ api: fakeApi({ getResearch: vi.fn().mockResolvedValue(archived) }) })
    expect(await screen.findByText('kubecode.research.archivedNotice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'kubecode.research.editBrief' })).toBeDisabled()
    openTab('kubecode.research.tab.work')
    expect(screen.queryByRole('button', { name: /kubecode.research.startRound/ })).not.toBeInTheDocument()
  })

  it('cannot start a round from a Task detail, and says where work starts', async () => {
    mount({ startsRounds: false })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    expect(await screen.findByText('kubecode.task.startsInGeneral')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /kubecode.research.startRound/ })).not.toBeInTheDocument()
  })

  it('moves the question between open, resolved, and archived by explicit command', async () => {
    const setResearchState = vi.fn().mockResolvedValue(detailFixture)
    mount({ api: fakeApi({ setResearchState }) })
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.resolve' }))
    await waitFor(() => expect(setResearchState).toHaveBeenCalledWith('p1', 'rq-1', 'resolve'))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.research.archive' }))
    await waitFor(() => expect(setResearchState).toHaveBeenCalledWith('p1', 'rq-1', 'archive'))
  })

  it('starts a discussion Session, links it, and opens it', async () => {
    const createConversation = vi.fn().mockResolvedValue({ id: 's-new', project_id: 'p1' })
    const linkResearch = vi.fn().mockResolvedValue(detailFixture)
    const { props } = mount({ api: fakeApi({ createConversation, linkResearch }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.startDiscussion' }))
    await waitFor(() => expect(props.onOpenSession).toHaveBeenCalledWith('s-new'))
    expect(createConversation).toHaveBeenCalledWith('p1', 'codex', 'Pruning')
    expect(linkResearch).toHaveBeenCalledWith('p1', 'rq-1', 'session', 's-new', 'discussion')
    expect(props.onConversationCreated).toHaveBeenCalled()
  })

  it('refetches on its own question events and on reconnect, not on unrelated ones', async () => {
    const getResearch = vi.fn().mockResolvedValue(detailFixture)
    const api = fakeApi({ getResearch })
    const props: ResearchWorkspaceProps = {
      agents, api, connectionState: 'live', conversations: [], events: [],
      onConversationCreated: vi.fn(), onOpenSession: vi.fn(),
      projectId: 'p1', researchId: 'rq-1', t, teams: [],
    }
    const view = render(<ResearchWorkspace {...props} />)
    await screen.findByText('Does structured pruning keep accuracy?')
    const initial = getResearch.mock.calls.length

    await act(async () => {
      view.rerender(<ResearchWorkspace {...props} events={[event(1, 'research_updated', { research_id: 'other' })]} />)
    })
    expect(getResearch.mock.calls.length).toBe(initial)

    await act(async () => {
      view.rerender(<ResearchWorkspace {...props} events={[
        event(1, 'research_updated', { research_id: 'other' }),
        event(2, 'research_updated', { research_id: 'rq-1', change: 'finding' }),
      ]} />)
    })
    await waitFor(() => expect(getResearch.mock.calls.length).toBe(initial + 1))

    await act(async () => {
      view.rerender(<ResearchWorkspace {...props} connectionState="reconnecting" events={[event(2, 'research_updated')]} />)
    })
    await act(async () => {
      view.rerender(<ResearchWorkspace {...props} connectionState="live" events={[event(2, 'research_updated')]} />)
    })
    await waitFor(() => expect(getResearch.mock.calls.length).toBe(initial + 2))
  })

  it('keeps an unsaved brief edit when switching tabs and back', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.research.editBrief' }))
    fireEvent.change(screen.getByLabelText('kubecode.research.field.title'), { target: { value: 'Half-typed' } })
    openTab('kubecode.research.tab.discussion')
    openTab('kubecode.research.tab.brief')
    expect(screen.getByLabelText('kubecode.research.field.title')).toHaveValue('Half-typed')
  })

  it('records from a Team source and changes the retry key when the content changes', async () => {
    const captureResearchFindings = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ created: true, findings: [] })
    const detail = { ...detailFixture, links: [detailFixture.links[1]] }
    mount({
      api: fakeApi({
        captureResearchFindings,
        getResearch: vi.fn().mockResolvedValue(detail),
      }),
    })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.findings')
    const statement = await panel().findByLabelText('kubecode.research.statement')
    fireEvent.change(statement, { target: { value: 'First wording' } })
    fireEvent.click(panel().getByRole('button', { name: 'kubecode.research.record' }))
    await waitFor(() => expect(captureResearchFindings).toHaveBeenCalledTimes(1))
    // Retrying the same content reuses the key; editing it must not.
    fireEvent.click(panel().getByRole('button', { name: 'kubecode.research.record' }))
    await waitFor(() => expect(captureResearchFindings).toHaveBeenCalledTimes(2))
    const [, , retry] = captureResearchFindings.mock.calls[1]
    expect(retry.publication_key).toBe(captureResearchFindings.mock.calls[0][2].publication_key)
    expect(retry.team_id).toBe('t-1')

    fireEvent.change(await panel().findByLabelText('kubecode.research.statement'), { target: { value: 'Second wording' } })
    fireEvent.click(panel().getByRole('button', { name: 'kubecode.research.record' }))
    await waitFor(() => expect(captureResearchFindings).toHaveBeenCalledTimes(3))
    expect(captureResearchFindings.mock.calls[2][2].publication_key).not.toBe(retry.publication_key)
  })

  it('does not open the new Session when linking it failed', async () => {
    const createConversation = vi.fn().mockResolvedValue({ id: 's-new', project_id: 'p1' })
    const linkResearch = vi.fn().mockRejectedValue(new ApiError('research_link_conflict', 'taken', 409))
    const { props } = mount({ api: fakeApi({ createConversation, linkResearch }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    fireEvent.click(await panel().findByRole('button', { name: 'kubecode.research.startDiscussion' }))
    expect(await panel().findByText('kubecode.research.error.linkConflict')).toBeInTheDocument()
    expect(props.onConversationCreated).not.toHaveBeenCalled()
    expect(props.onOpenSession).not.toHaveBeenCalled()
  })

  it('ignores events from other Projects and drops a stale response after switching questions', async () => {
    let resolveFirst: ((value: typeof detailFixture) => void) | undefined
    const getResearch = vi.fn().mockImplementation((_project: string, id: string) => (
      id === 'rq-1'
        ? new Promise<typeof detailFixture>((resolve) => { resolveFirst = resolve })
        : Promise.resolve({ ...detailFixture, id: 'rq-2', brief: { ...detailFixture.brief, title: 'Second' } })
    ))
    const api = fakeApi({ getResearch })
    const props: ResearchWorkspaceProps = {
      agents, api, connectionState: 'live', conversations: [], events: [],
      onConversationCreated: vi.fn(), onOpenSession: vi.fn(),
      projectId: 'p1', researchId: 'rq-1', t, teams: [],
    }
    const view = render(<ResearchWorkspace {...props} />)
    view.rerender(<ResearchWorkspace {...props} researchId="rq-2" />)
    expect(await screen.findByRole('heading', { name: 'Second' })).toBeInTheDocument()
    // The slow response for the first question arrives last and is ignored.
    await act(async () => resolveFirst?.(detailFixture))
    expect(screen.getByRole('heading', { name: 'Second' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pruning' })).not.toBeInTheDocument()

    const before = getResearch.mock.calls.length
    const foreign = { ...event(9, 'session_removed'), project_id: 'other-project' }
    await act(async () => {
      view.rerender(<ResearchWorkspace {...props} researchId="rq-2" events={[foreign]} />)
    })
    expect(getResearch.mock.calls.length).toBe(before)
  })

  it('starts a round with an execution envelope only when it is valid, and without one by default', async () => {
    const startResearchRound = vi.fn().mockResolvedValue(roundFixture)
    mount({ api: fakeApi({ startResearchRound }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    const start = await panel().findByRole('button', { name: /kubecode.research.startRound/ })

    // No envelope unless the researcher opts in: nothing could run.
    fireEvent.click(start)
    await waitFor(() => expect(startResearchRound).toHaveBeenCalledTimes(1))
    expect(startResearchRound.mock.calls[0][2].envelope).toBeUndefined()

    fireEvent.click(panel().getByLabelText('kubecode.research.exec.allowExecution'))
    expect(panel().getByText('kubecode.research.exec.envelopeHint')).toBeInTheDocument()
    fireEvent.click(start)
    expect(await panel().findByText('kubecode.research.exec.invalid')).toBeInTheDocument()
    expect(startResearchRound).toHaveBeenCalledTimes(1)

    fireEvent.change(panel().getByLabelText('kubecode.research.exec.allowedCommands'), {
      target: { value: 'python3 train.py' },
    })
    fireEvent.click(start)
    await waitFor(() => expect(startResearchRound).toHaveBeenCalledTimes(2))
    expect(startResearchRound.mock.calls[1][2].envelope).toMatchObject({
      max_launches: 5,
      max_concurrent: 1,
      max_runtime_secs: 1800,
      allowed_commands: [['python3', 'train.py']],
    })
  })

  it('does not start a round when Enter is pressed in an envelope field', async () => {
    const startResearchRound = vi.fn().mockResolvedValue(roundFixture)
    mount({ api: fakeApi({ startResearchRound }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    fireEvent.click(await panel().findByLabelText('kubecode.research.exec.allowExecution'))
    const launches = panel().getByLabelText('kubecode.research.exec.maxLaunches')
    // jsdom does not submit implicit forms on Enter, but the keydown must be cancelled.
    const notCancelled = fireEvent.keyDown(launches, { key: 'Enter' })
    expect(notCancelled).toBe(false)
    expect(startResearchRound).not.toHaveBeenCalled()
  })

  it('lets the researcher hide and re-show the newest round\'s execution', async () => {
    mount()
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    const toggle = await panel().findByRole('button', { name: /kubecode\.research\.exec\.hide/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(panel().getByRole('button', { name: /kubecode\.research\.exec\.show/ })).toHaveAttribute('aria-expanded', 'false')
    expect(panel().queryByText('kubecode.research.exec.title')).not.toBeInTheDocument()
  })

  it('refreshes link availability when a Session is removed', async () => {
    const getResearch = vi.fn().mockResolvedValue(detailFixture)
    const props: ResearchWorkspaceProps = {
      agents, api: fakeApi({ getResearch }), connectionState: 'live', conversations: [], events: [],
      onConversationCreated: vi.fn(), onOpenSession: vi.fn(),
      projectId: 'p1', researchId: 'rq-1', t, teams: [],
    }
    const view = render(<ResearchWorkspace {...props} />)
    await screen.findByText('Does structured pruning keep accuracy?')
    const initial = getResearch.mock.calls.length
    await act(async () => {
      view.rerender(<ResearchWorkspace {...props} events={[event(5, 'session_removed')]} />)
    })
    await waitFor(() => expect(getResearch.mock.calls.length).toBe(initial + 1))
  })
})
