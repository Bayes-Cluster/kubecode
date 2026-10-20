import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError, type KubecodeApi, type TaskDetail } from '../api'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import { INSPECTOR_PANELS } from '../app/inspector/inspectorPanels'
import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import { reviewRequest, taskDetail } from './taskFixtures'

vi.mock('../research/ResearchFindingsPanel', () => ({ ResearchFindingsPanel: () => <p>findings panel</p> }))
vi.mock('../research/ResearchBriefPanel', () => ({
  ResearchBriefPanel: ({ onDone }: { onDone?: () => void }) => (
    <form aria-label="brief editor"><button type="button" onClick={onDone}>Done editing</button></form>
  ),
}))

const researchDetail = {
  id: 'r1', project_id: 'p1', revision: 1, status: 'open', archived: false,
  brief: { title: 'Quantize', question: 'Does int8 keep accuracy?', motivation: '', hypotheses: [], constraints: [], evaluation_criteria: ['within one point'] },
}

function services(detail: TaskDetail | 'draft', overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}, archived: string[] = []) {
  const api = {
    taskDetail: detail === 'draft'
      ? vi.fn().mockRejectedValue(new ApiError('task_not_found', 'x', 404))
      : vi.fn().mockResolvedValue(detail),
    archiveTask: vi.fn().mockResolvedValue(undefined),
    restoreTask: vi.fn().mockResolvedValue(undefined),
    reviewTask: vi.fn(),
    getResearch: vi.fn().mockResolvedValue(researchDetail),
    listResearchEntries: vi.fn().mockResolvedValue([]),
    listResearchFindings: vi.fn().mockResolvedValue([]),
    listResearchOutcomes: vi.fn().mockResolvedValue([]),
    listResearchProposals: vi.fn().mockResolvedValue([]),
    listResearchRounds: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as KubecodeApi
  return fakeServices({
    api,
    taskBoard: {
      board: { cards: [], stages: [], total: 0, archived: archived.map((id) => ({ id, title: 'Quantize', stage: null, outcome: null, updated_at: '' })) },
      drafts: detail === 'draft'
        ? [{ id: 'r1', project_id: 'p1', title: 'Quantize', question: '?', revision: 2, proposed_by: 'agent', updated_at: '', shown_message_id: 'm-shown' }]
        : [],
      reload: vi.fn(),
    },
  })
}

function MemberProbe() {
  return <InspectorPanel title="Analyst">member profile</InspectorPanel>
}

function mount(detail: TaskDetail | 'draft', overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}, archived: string[] = []) {
  const navigation = fakeNavigation()
  const served = services(detail, overrides, archived)
  renderInspector({
    navigation,
    panels: { ...INSPECTOR_PANELS, member: MemberProbe },
    services: served,
    stack: [{ kind: 'task', id: 'r1' }],
  })
  return { api: served.api, navigation, reloadBoard: served.taskBoard?.reload }
}

const panel = () => within(screen.getByRole('complementary', { name: 'Task details' }))
const FORBIDDEN = /mark resolved|reopen|start round|add to|admit|approve|confirm|^start/i
const openMore = async () => {
  fireEvent.pointerDown(await panel().findByRole('button', { name: 'More actions for this Task' }), { button: 0, ctrlKey: false })
}

describe('TaskPanel', () => {
  it('shows one state, the stage, and no research status or way to finish, admit or start', async () => {
    mount(taskDetail({ stage: 'in_progress', review_requested: false, review_requests: [], condition: 'blocked', condition_reason: 'needs a GPU' }))
    expect(await panel().findByRole('heading', { name: 'Pruning heads', level: 3 })).toBeInTheDocument()
    expect(panel().getAllByText('In progress')).toHaveLength(1)
    expect(panel().getByText('Blocked')).toBeInTheDocument()
    expect(panel().getByText('needs a GPU')).toBeInTheDocument()
    expect(panel().queryByText(/^(Open|Resolved)$/)).not.toBeInTheDocument()
    expect(panel().queryAllByRole('button').filter((button) => FORBIDDEN.test(button.textContent ?? ''))).toEqual([])
    expect(panel().getByText('Specialists are working. The General Agent will ask you to review the results.')).toBeInTheDocument()
  })

  it('opens on the results while a review waits, and keeps the chosen section', async () => {
    mount(taskDetail())
    expect(await panel().findByRole('tab', { name: /Results/, selected: true })).toBeInTheDocument()
    expect(panel().getByText('Results are ready for your decision.')).toBeInTheDocument()
    expect(panel().getByRole('region', { name: 'Results for your review' })).toBeInTheDocument()
    fireEvent.mouseDown(panel().getByRole('tab', { name: 'Overview' }), { button: 0 })
    expect(panel().getByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument()
    // The review stays mounted while another section is shown, so nothing typed is lost.
    expect(panel().getByLabelText('Feedback for the team')).toBeInTheDocument()
    fireEvent.click(panel().getByRole('button', { name: 'Review results' }))
    expect(panel().getByRole('tab', { name: /Results/, selected: true })).toBeInTheDocument()
  })

  it('stays on the results after a decision, so the researcher sees what happened and where it went', async () => {
    const done = taskDetail({
      stage: 'done', outcome: 'refuted', review_requested: false,
      review_requests: [reviewRequest({ state: 'accepted' })], pending: [],
    })
    const taskDetailCall = vi.fn().mockResolvedValueOnce(taskDetail()).mockResolvedValue(done)
    mount(taskDetail(), {
      taskDetail: taskDetailCall,
      reviewTask: vi.fn().mockResolvedValue({ id: 'v1', accepted: true, general_message_id: 'gm1' }),
    })
    fireEvent.click(await panel().findByRole('radio', { name: 'Valid negative result' }))
    fireEvent.click(panel().getByRole('button', { name: 'Accept results' }))
    expect(await panel().findByText(/Accepted as Valid negative result/)).toBeInTheDocument()
    await waitFor(() => expect(taskDetailCall).toHaveBeenCalledTimes(2))
    expect(panel().getByRole('tab', { name: /Results/, selected: true })).toBeInTheDocument()
    expect(panel().getByText(/Accepted as Valid negative result/)).toBeVisible()
  })

  it('opens on the overview otherwise, with goal, provenance and people, and opens a member over the Task', async () => {
    const { navigation } = mount(taskDetail({ stage: 'ready', review_requested: false, review_requests: [], revision: 3, approved_revision: 2 }))
    expect(await panel().findByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument()
    expect(panel().getByText('Brief revision 3 waits for your approval in General.')).toBeInTheDocument()
    expect(panel().getByText('Late heads are redundant')).toBeInTheDocument()
    expect(panel().getByText('Work follows brief revision 2')).toBeInTheDocument()
    expect(panel().getByText('That looks right. Please add it.')).toBeInTheDocument()
    fireEvent.click(panel().getByRole('button', { name: 'Show the message' }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', message: 'm1', thread: null, filter: null },
      { inspector: 'keep' },
    )
    expect(panel().getByText('Project manager')).toBeInTheDocument()
    fireEvent.click(panel().getByRole('button', { name: 'Analyst' }))
    expect(await screen.findByText('member profile')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pruning heads' }))
    expect(panel().getByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument()
  })

  it('discusses the Task in General, at the review request when one is open', async () => {
    const { navigation } = mount(taskDetail())
    fireEvent.click(await panel().findByRole('button', { name: 'Discuss in General' }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', filter: 'r1', message: 'm-req', thread: null },
      { inspector: 'keep', focus: 'composer:general' },
    )
  })

  it('on a phone, discussing replaces the Task with General rather than a Task General remembered', async () => {
    const navigation = fakeNavigation({ presentation: 'screen' })
    renderInspector({ navigation, presentation: 'screen', services: services(taskDetail()), stack: [{ kind: 'task', id: 'r1' }] })
    fireEvent.click(await panel().findByRole('button', { name: 'Discuss in General' }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', filter: 'r1', message: 'm-req', thread: null },
      { inspector: 'closed', focus: 'composer:general' },
    )
  })

  it('discusses a Task with no open review at the latest of General', async () => {
    const { navigation } = mount(taskDetail({ stage: 'in_progress', review_requests: [reviewRequest({ state: 'returned' })] }))
    fireEvent.click(await panel().findByRole('button', { name: 'Discuss in General' }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', filter: 'r1', message: null, thread: null },
      { inspector: 'keep', focus: 'composer:general' },
    )
  })

  it('archives a Task the server allows to be archived, after asking', async () => {
    const { api, reloadBoard } = mount(taskDetail({
      stage: 'done', review_requests: [reviewRequest({ state: 'accepted' })],
      actions: { archive: { allowed: true, reason: null }, restore: false },
    }))
    await openMore()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive Task' }))
    const dialog = await screen.findByRole('dialog', { name: 'Archive “Pruning heads”?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(api.archiveTask).toHaveBeenCalledWith('p1', 'r1'))
    await waitFor(() => expect(reloadBoard).toHaveBeenCalled())
  })

  it('says why a Task under review cannot be archived, instead of hiding it', async () => {
    const { api } = mount(taskDetail())
    await openMore()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive Task' }))
    const dialog = await screen.findByRole('dialog', { name: 'This Task can\'t be archived now' })
    expect(within(dialog).getByText('Decide its review first: accept the results or send them back.')).toBeInTheDocument()
    expect(api.archiveTask).not.toHaveBeenCalled()
  })

  it('says why when the server refuses an archive that raced a change', async () => {
    mount(taskDetail({
      stage: 'in_progress', review_requests: [],
      actions: { archive: { allowed: true, reason: null }, restore: false },
    }), { archiveTask: vi.fn().mockRejectedValue(new ApiError('task_active', 'x', 409, null, 'work_active')) })
    await openMore()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive Task' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }))
    expect(await screen.findByText(/Its work is still running/)).toBeInTheDocument()
  })

  it('restores an archived Task, which says it is archived and offers no decision', async () => {
    const { api } = mount(taskDetail({
      archived: true,
      actions: { archive: { allowed: false, reason: 'archived' }, restore: true },
    }))
    expect(await panel().findByText('Archived. It is off the board; restore it to continue.')).toBeInTheDocument()
    expect(panel().getByText('Archived')).toBeInTheDocument()
    expect(panel().getByRole('button', { name: 'Accept results' })).toBeDisabled()
    fireEvent.click(panel().getByRole('button', { name: 'Restore to the board' }))
    await waitFor(() => expect(api.restoreTask).toHaveBeenCalledWith('p1', 'r1'))
  })

  it('shows a proposal as a draft: its brief, how it gets on the board, and the message that showed it', async () => {
    const { navigation } = mount('draft')
    expect(await panel().findByRole('heading', { name: 'Quantize', level: 3 })).toBeInTheDocument()
    expect(panel().getByText('Draft')).toBeInTheDocument()
    expect(panel().getByText(/This is a proposal and is not on the board/)).toBeInTheDocument()
    expect(await panel().findByText('Does int8 keep accuracy?')).toBeInTheDocument()
    expect(panel().queryByRole('tab')).not.toBeInTheDocument()
    expect(panel().queryAllByRole('button').filter((button) => FORBIDDEN.test(button.textContent ?? ''))).toEqual([])
    await openMore()
    expect(await screen.findByRole('menuitem', { name: 'Archive proposal' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show the proposal' }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', message: 'm-shown', thread: null, filter: null },
      { inspector: 'keep' },
    )
  })

  it('shows an archived proposal with the way back', async () => {
    const { api } = mount('draft', {}, ['r1'])
    expect(await panel().findByText('Archived. It is off the board; restore it to continue.')).toBeInTheDocument()
    fireEvent.click(panel().getByRole('button', { name: 'Restore to the board' }))
    await waitFor(() => expect(api.restoreTask).toHaveBeenCalledWith('p1', 'r1'))
  })

  it('edits the brief in place and comes back to the goal', async () => {
    mount(taskDetail({ stage: 'ready', review_requests: [] }))
    fireEvent.click(await panel().findByRole('button', { name: 'Edit brief' }))
    fireEvent.click(await panel().findByRole('button', { name: 'Done editing' }))
    expect(panel().getByText('Late heads are redundant')).toBeInTheDocument()
  })

  it('says the Task could not be loaded and tries again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(taskDetail())
    mount(taskDetail(), { taskDetail: load })
    fireEvent.click(await panel().findByRole('button', { name: 'Retry' }))
    expect(await panel().findByRole('heading', { name: 'Pruning heads', level: 3 })).toBeInTheDocument()
  })
})
