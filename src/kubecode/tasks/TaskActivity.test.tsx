import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, TaskActivity as TaskActivityStep, TaskDetail } from '../api'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import { INSPECTOR_PANELS } from '../app/inspector/inspectorPanels'
import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import type { ResearchBundle } from '../research/useResearch'
import { TaskActivity } from './TaskActivity'
import { taskDetail } from './taskFixtures'

vi.mock('../research/ResearchRoundsPanel', () => ({
  ResearchRoundsPanel: ({ startsRounds }: { startsRounds?: boolean }) => (
    <p>rounds panel, starts rounds: {String(startsRounds)}</p>
  ),
}))
vi.mock('../research/ResearchThreadsPanel', () => ({
  ResearchThreadsPanel: ({ onOpenThread }: { onOpenThread: (id: string) => void }) => (
    <button type="button" onClick={() => onOpenThread('t1')}>thread t1</button>
  ),
}))
vi.mock('../research/ResearchImportPanel', () => ({ ResearchImportPanel: () => <p>imports panel</p> }))
vi.mock('../research/ResearchExportPanel', () => ({ ResearchExportPanel: () => <p>export panel</p> }))

const step = (overrides: Partial<TaskActivityStep>): TaskActivityStep => ({
  at: '2026-10-20 09:00:00',
  kind: 'admitted',
  actor: 'researcher',
  member: null,
  brief_revision: null,
  ref_id: null,
  message_id: null,
  excerpt: null,
  ...overrides,
})

const gene = { member_id: 'g', name: 'Gene', handle: 'general', role: 'general' as const }
const analyst = { member_id: 'a', name: 'Analyst', handle: 'analyst', role: 'specialist' as const }

function mount(detail: TaskDetail, bundle: ResearchBundle | null = null) {
  const api = {
    listChannels: vi.fn().mockResolvedValue([{ id: 'c1', is_default: true }]),
    listChannelMessages: vi.fn().mockResolvedValue({
      messages: [{ id: 'gm7', body: 'The sweep is half done.\nMore later.', author_kind: 'member', created_at: '2026-10-20 10:00:00' }],
      has_more: false,
    }),
    listResearchImports: vi.fn().mockResolvedValue([]),
  } as unknown as KubecodeApi
  const navigation = fakeNavigation()
  function Probe() {
    return <InspectorPanel title="Pruning heads"><TaskActivity bundle={bundle} detail={detail} projectId="p1" /></InspectorPanel>
  }
  renderInspector({
    navigation,
    panels: { ...INSPECTOR_PANELS, task: Probe },
    services: fakeServices({ api }),
    stack: [{ kind: 'task', id: 'r1' }],
  })
  return { api, navigation }
}

describe('TaskActivity', () => {
  it('tells each step in words, newest first, with the researcher\'s words and the way to the message in General', async () => {
    const { navigation } = mount(taskDetail({
      timeline: [
        step({ kind: 'proposed', actor: 'manager', member: gene, brief_revision: 1, at: '2026-10-20 08:00:00', message_id: 'gm1' }),
        step({ kind: 'admitted', excerpt: 'That looks right. Please add it.', message_id: 'm1' }),
        step({ kind: 'revised', actor: 'researcher', brief_revision: 2, at: '2026-10-20 09:10:00' }),
        step({ kind: 'revision_approved', brief_revision: 2, at: '2026-10-20 09:20:00' }),
        step({ kind: 'execution_authorized', at: '2026-10-20 09:30:00' }),
        step({ kind: 'review_requested', actor: 'member', member: analyst, at: '2026-10-20 09:40:00' }),
        step({ kind: 'review_returned', at: '2026-10-20 09:50:00' }),
        step({ kind: 'review_accepted', at: '2026-10-20 10:00:00' }),
        step({ kind: 'archived', at: '2026-10-20 10:10:00' }),
        step({ kind: 'restored', at: '2026-10-20 10:20:00' }),
      ],
    }))
    const history = within(await screen.findByRole('list', { name: 'History' }))
    const rows = history.getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('You restored it'),
      expect.stringContaining('You archived it'),
      expect.stringContaining('You accepted the results'),
      expect.stringContaining('You sent it back'),
      expect.stringContaining('Analyst asked for your review'),
      expect.stringContaining('Work started on your instruction'),
      expect.stringContaining('You approved revision 2'),
      expect.stringContaining('You revised the brief to revision 2'),
      expect.stringContaining('Added to the board by your message'),
      expect.stringContaining('Gene proposed revision 1'),
    ])
    expect(within(rows[8]).getByText('That looks right. Please add it.')).toBeInTheDocument()
    fireEvent.click(within(rows[8]).getByRole('button', { name: 'Show in General' }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', filter: 'r1', message: 'm1', thread: null },
      { inspector: 'keep' },
    )
  })

  it('says when nothing has happened', async () => {
    mount(taskDetail({ timeline: [] }))
    expect(await screen.findByText('Nothing has happened yet.')).toBeInTheDocument()
  })

  it('shows what was said about the Task in General lately, one line each', async () => {
    const { api, navigation } = mount(taskDetail())
    const recent = await screen.findByRole('region', { name: 'Recently in General about this Task' })
    await waitFor(() => expect(api.listChannelMessages).toHaveBeenCalledWith('p1', 'c1', { taskId: 'r1', limit: 5 }))
    fireEvent.click(await within(recent).findByRole('button', { name: /The sweep is half done\./ }))
    expect(navigation.openPlace).toHaveBeenCalledWith(
      { view: 'general', filter: 'r1', message: 'gm7', thread: null },
      { inspector: 'keep' },
    )
  })

  it('opens execution records and linked records only when asked, and starts nothing', async () => {
    const bundle = { detail: { id: 'r1' }, entries: [], findings: [], outcomes: [], proposals: [], rounds: [] } as unknown as ResearchBundle
    const { navigation } = mount(taskDetail({
      internal_work: [{
        id: 'w1', title: 'Pruning sweep', stage: 'executing', condition: 'none', lifecycle: 'active',
        attempts: 1, experiments: 2, assignee: null, conversation_id: 's7', updated_at: '',
      }],
    }), bundle)
    expect(screen.queryByText(/rounds panel/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Execution records'))
    expect(await screen.findByText('rounds panel, starts rounds: false')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open session: Pruning sweep' }))
    expect(navigation.openSession).toHaveBeenCalledWith('s7')
    fireEvent.click(screen.getByText('Linked records'))
    expect(await screen.findByText('imports panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'thread t1' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'general', thread: 't1', filter: null }, { inspector: 'closed' })
  })
})
