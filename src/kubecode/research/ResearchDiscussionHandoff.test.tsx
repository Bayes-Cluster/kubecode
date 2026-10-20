import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api'
import type { ResearchImport, ResearchImportDetail } from '../api'
import { detailFixture, fakeApi, roundFixture } from './researchFixtures'
import { ResearchWorkspace, type ResearchWorkspaceProps } from './ResearchWorkspace'

const t = ((key: string, values?: Record<string, unknown>) => (
  values ? `${key} ${JSON.stringify(values)}` : key
)) as never

const agents = [{ id: 'codex', available: true, version: null, executable: 'codex', error: null }] as never

const imported: ResearchImport = {
  id: 'imp-1',
  research_id: 'rq-1',
  origin: 'markdown',
  label: 'Call with the group',
  based_on_revision: 1,
  digest: 'd'.repeat(64),
  byte_count: 120,
  created_at: '2026-10-02 09:00:00',
  current_revision: 2,
  stale: true,
}

const importDetail: ResearchImportDetail = {
  ...imported,
  content: '## Constraints\n- No more than 4 GPUs\n## Decisions\n- Use structured pruning only',
  candidates: [
    { kind: 'constraint', text: 'No more than 4 GPUs', line: 2 },
    { kind: 'decision', text: 'Use structured pruning only', line: 4 },
    { kind: 'open_question', text: 'Does it survive another seed?', line: 6 },
  ],
}

function mount(overrides: Partial<ResearchWorkspaceProps> = {}) {
  const props: ResearchWorkspaceProps = {
    agents,
    api: fakeApi({
      listResearchImports: vi.fn().mockResolvedValue([imported]),
      getResearchImport: vi.fn().mockResolvedValue(importDetail),
    }),
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
  return { ...render(<ResearchWorkspace {...props} />), props }
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })
}

const importSection = () => within(screen.getByRole('region', { name: 'kubecode.research.import.title' }))

async function openDiscussion() {
  await screen.findByText('Does structured pruning keep accuracy?')
  openTab('kubecode.research.tab.discussion')
}

describe('imported discussion', () => {
  it('saves pasted text as source material under a stable key and starts nothing', async () => {
    const createResearchImport = vi.fn()
      .mockRejectedValueOnce(new ApiError('internal_error', 'down', 500))
      .mockResolvedValue({ ...imported, created: true })
    const startResearchRound = vi.fn()
    const updateResearch = vi.fn()
    mount({
      api: fakeApi({
        createResearchImport,
        startResearchRound,
        updateResearch,
        listResearchImports: vi.fn().mockResolvedValue([]),
      }),
    })
    await openDiscussion()
    expect(await importSection().findByText('kubecode.research.import.empty')).toBeInTheDocument()
    fireEvent.change(importSection().getByLabelText('kubecode.research.import.label'), {
      target: { value: 'Slack thread' },
    })
    fireEvent.change(importSection().getByLabelText('kubecode.research.import.text'), {
      target: { value: '- Decision: ship it' },
    })
    const submit = importSection().getByRole('button', { name: 'kubecode.research.import.submit' })
    fireEvent.click(submit)
    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(1))
    // A failed attempt keeps the text so nothing is lost.
    await screen.findAllByRole('alert')
    expect(importSection().getByLabelText('kubecode.research.import.text')).toHaveValue('- Decision: ship it')
    fireEvent.click(submit)
    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(2))
    const [project, research, request] = createResearchImport.mock.calls[1]
    expect([project, research]).toEqual(['p1', 'rq-1'])
    expect(request).toMatchObject({
      origin: 'markdown', label: 'Slack thread', content: '- Decision: ship it', based_on_revision: 2,
    })
    // The retry reuses the key, so a lost response cannot create a duplicate.
    expect(request.client_request_id).toBe(createResearchImport.mock.calls[0][2].client_request_id)
    expect(await importSection().findByText('kubecode.research.import.saved')).toBeInTheDocument()
    expect(importSection().getByLabelText('kubecode.research.import.text')).toHaveValue('')
    expect(startResearchRound).not.toHaveBeenCalled()
    expect(updateResearch).not.toHaveBeenCalled()
  })

  it('refuses text over the size limit and empty fields before sending', async () => {
    const createResearchImport = vi.fn()
    mount({ api: fakeApi({ createResearchImport, listResearchImports: vi.fn().mockResolvedValue([]) }) })
    await openDiscussion()
    const submit = await importSection().findByRole('button', { name: 'kubecode.research.import.submit' })
    expect(submit).toBeDisabled()
    fireEvent.change(importSection().getByLabelText('kubecode.research.import.label'), { target: { value: 'x' } })
    fireEvent.change(importSection().getByLabelText('kubecode.research.import.text'), {
      target: { value: 'a'.repeat(64 * 1024 + 1) },
    })
    expect(submit).toBeDisabled()
    expect(importSection().getByText('kubecode.research.import.tooLarge')).toBeInTheDocument()
    expect(createResearchImport).not.toHaveBeenCalled()
  })

  it('flags a discussion written against an older brief and compares before applying', async () => {
    const updateResearch = vi.fn().mockResolvedValue(detailFixture)
    const addResearchEntry = vi.fn().mockResolvedValue({})
    mount({
      api: fakeApi({
        updateResearch,
        addResearchEntry,
        listResearchImports: vi.fn().mockResolvedValue([imported]),
        getResearchImport: vi.fn().mockResolvedValue(importDetail),
      }),
    })
    await openDiscussion()
    expect(await importSection().findByText(/kubecode.research.import.stale/)).toHaveTextContent('"based":1')
    fireEvent.click(importSection().getByRole('button', { name: /kubecode.research.import.reviewItem/ }))
    expect(await importSection().findByText('kubecode.research.import.staleWarning')).toBeInTheDocument()
    const apply = importSection().getByRole('button', { name: /kubecode.research.import.apply/ })
    expect(apply).toBeDisabled()
    expect(importSection().getByText('kubecode.research.import.proposalNone')).toBeInTheDocument()
    // Open questions are shown but cannot be selected into the brief.
    expect(importSection().getByRole('checkbox', { name: /Does it survive another seed/ })).toBeDisabled()

    fireEvent.click(importSection().getByRole('checkbox', { name: /No more than 4 GPUs/ }))
    fireEvent.click(importSection().getByRole('checkbox', { name: /Use structured pruning only/ }))
    // The comparison shows the current and the proposed constraints side by side.
    expect(importSection().getByText('kubecode.research.field.constraints')).toBeInTheDocument()
    expect(importSection().getByText(/single GPU No more than 4 GPUs/)).toBeInTheDocument()
    expect(updateResearch).not.toHaveBeenCalled()

    fireEvent.click(importSection().getByRole('button', { name: /kubecode.research.import.apply/ }))
    await waitFor(() => expect(updateResearch).toHaveBeenCalledTimes(1))
    // Under the revision the researcher is looking at, naming the import.
    expect(updateResearch).toHaveBeenCalledWith(
      'p1', 'rq-1', 2, { constraints: ['single GPU', 'No more than 4 GPUs'] }, undefined, 'imp-1',
    )
    await waitFor(() => expect(addResearchEntry).toHaveBeenCalledTimes(1))
    expect(addResearchEntry.mock.calls[0].slice(0, 4)).toEqual([
      'p1', 'rq-1', 'decision', 'Use structured pruning only (Call with the group)',
    ])
  })

  it('keeps the reviewed selection when a newer brief refuses the edit', async () => {
    const updateResearch = vi.fn().mockRejectedValue(
      new ApiError('research_revision_conflict', 'moved', 409),
    )
    mount({
      api: fakeApi({
        updateResearch,
        listResearchImports: vi.fn().mockResolvedValue([imported]),
        getResearchImport: vi.fn().mockResolvedValue(importDetail),
      }),
    })
    await openDiscussion()
    fireEvent.click(await importSection().findByRole('button', { name: /kubecode.research.import.reviewItem/ }))
    const constraint = await importSection().findByRole('checkbox', { name: /No more than 4 GPUs/ })
    fireEvent.click(constraint)
    fireEvent.click(importSection().getByRole('button', { name: /kubecode.research.import.apply/ }))
    expect(await importSection().findByText('kubecode.research.error.revisionConflict')).toBeInTheDocument()
    // Nothing was overwritten and the researcher's selection is intact.
    expect(constraint).toBeChecked()
  })

  it('shows a load failure for a discussion instead of an empty review', async () => {
    mount({
      api: fakeApi({
        listResearchImports: vi.fn().mockResolvedValue([imported]),
        getResearchImport: vi.fn().mockRejectedValue(new Error('gone')),
      }),
    })
    await openDiscussion()
    fireEvent.click(await importSection().findByRole('button', { name: /kubecode.research.import.reviewItem/ }))
    expect(await importSection().findByText('kubecode.research.import.loadFailed')).toBeInTheDocument()
  })

  it('cannot import into or apply to an archived question', async () => {
    mount({
      api: fakeApi({
        getResearch: async () => ({ ...detailFixture, archived: true }),
        listResearchImports: vi.fn().mockResolvedValue([imported]),
        getResearchImport: vi.fn().mockResolvedValue(importDetail),
      }),
    })
    await openDiscussion()
    await importSection().findByText('Call with the group')
    expect(importSection().queryByLabelText('kubecode.research.import.text')).not.toBeInTheDocument()
    fireEvent.click(importSection().getByRole('button', { name: /kubecode.research.import.reviewItem/ }))
    expect(await importSection().findByRole('checkbox', { name: /No more than 4 GPUs/ })).toBeDisabled()
    expect(importSection().getByRole('button', { name: /kubecode.research.import.apply/ })).toBeDisabled()
  })
})

describe('handoff to a round', () => {
  it('cites an imported discussion only when asked, through the existing round action', async () => {
    const startResearchRound = vi.fn().mockResolvedValue(roundFixture)
    mount({
      api: fakeApi({
        startResearchRound,
        listResearchImports: vi.fn().mockResolvedValue([imported]),
      }),
    })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.work')
    const cite = await screen.findByRole('checkbox', { name: /Call with the group/ })
    expect(cite).not.toBeChecked()
    expect(screen.getByText(/kubecode.research.import.handoffSummary/)).toHaveTextContent('"count":0')
    fireEvent.click(screen.getByRole('button', { name: /kubecode.research.startRound/ }))
    await waitFor(() => expect(startResearchRound).toHaveBeenCalledTimes(1))
    expect(startResearchRound.mock.calls[0][2].sources).not.toContainEqual({ kind: 'import', id: 'imp-1' })
    const firstKey = startResearchRound.mock.calls[0][2].client_request_id

    fireEvent.click(cite)
    expect(screen.getByText(/kubecode.research.import.handoffSummary/)).toHaveTextContent('"count":1')
    fireEvent.click(screen.getByRole('button', { name: /kubecode.research.startRound/ }))
    await waitFor(() => expect(startResearchRound).toHaveBeenCalledTimes(2))
    const request = startResearchRound.mock.calls[1][2]
    expect(request).toMatchObject({ expected_revision: 2 })
    expect(request.sources).toContainEqual({ kind: 'import', id: 'imp-1' })
    // A different ask is a different intent, so it does not reuse the key.
    expect(request.client_request_id).not.toBe(firstKey)
  })
})

describe('discussion packet export', () => {
  const packet = {
    research_id: 'rq-1',
    brief_revision: 2,
    sections: [
      { id: 'brief', included: true, bytes: 40, truncated: false },
      { id: 'progress', included: true, bytes: 20, truncated: false },
      { id: 'findings', included: true, bytes: 20, truncated: false },
      { id: 'evidence', included: false, bytes: 0, truncated: false },
      { id: 'open_questions', included: true, bytes: 20, truncated: false },
    ],
    markdown: '# Research discussion packet\n\nQuestion: Pruning (brief revision 2).',
    total_bytes: 71,
    truncated: false,
  }

  it('previews exactly what leaves, only for the chosen sections, and copies on request', async () => {
    const exportResearchPacket = vi.fn().mockResolvedValue(packet)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mount({ api: fakeApi({ exportResearchPacket, listResearchImports: vi.fn().mockResolvedValue([]) }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    const exportSection = within(await screen.findByRole('region', { name: 'kubecode.research.export.title' }))
    fireEvent.click(exportSection.getByRole('checkbox', { name: 'kubecode.research.export.section.evidence' }))
    fireEvent.click(exportSection.getByRole('button', { name: 'kubecode.research.export.preview' }))
    await waitFor(() => expect(exportResearchPacket).toHaveBeenCalledTimes(1))
    expect(exportResearchPacket).toHaveBeenCalledWith('p1', 'rq-1', [
      'brief', 'progress', 'findings', 'open_questions',
    ])
    // The statement of what leaves follows the sections actually included.
    expect(await exportSection.findByText('kubecode.research.export.contents.brief')).toBeInTheDocument()
    expect(exportSection.getByText('kubecode.research.export.contents.findings')).toBeInTheDocument()
    expect(exportSection.queryByText('kubecode.research.export.contents.evidence')).not.toBeInTheDocument()
    expect(exportSection.getByText('kubecode.research.export.contents.never')).toBeInTheDocument()
    expect(exportSection.getByLabelText('kubecode.research.export.packet')).toHaveValue(packet.markdown)
    expect(writeText).not.toHaveBeenCalled()
    fireEvent.click(exportSection.getByRole('button', { name: 'kubecode.research.export.copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(packet.markdown))
    expect(await exportSection.findByText('kubecode.research.export.copied')).toBeInTheDocument()
  })

  it('reports a build failure and a copy failure, and needs at least one section', async () => {
    const exportResearchPacket = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ ...packet, truncated: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    mount({ api: fakeApi({ exportResearchPacket, listResearchImports: vi.fn().mockResolvedValue([]) }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    const exportSection = within(await screen.findByRole('region', { name: 'kubecode.research.export.title' }))
    const preview = exportSection.getByRole('button', { name: 'kubecode.research.export.preview' })
    fireEvent.click(preview)
    expect(await exportSection.findByText('kubecode.research.export.previewFailed')).toBeInTheDocument()
    fireEvent.click(preview)
    expect(await exportSection.findByText('kubecode.research.export.truncated')).toBeInTheDocument()
    fireEvent.click(exportSection.getByRole('button', { name: 'kubecode.research.export.copy' }))
    expect(await exportSection.findByText('kubecode.research.export.copyFailed')).toBeInTheDocument()
    for (const name of [
      'brief', 'progress', 'findings', 'evidence', 'open_questions',
    ]) {
      fireEvent.click(exportSection.getByRole('checkbox', { name: `kubecode.research.export.section.${name}` }))
    }
    expect(preview).toBeDisabled()
  })
})

describe('review and export under change', () => {
  const event = (id: number) => ({
    id, kind: 'research_updated', project_id: 'p1', conversation_id: null, run_id: null,
    payload: { research_id: 'rq-1' }, created_at: '',
  }) as never

  it('holds Apply when the approved brief moves under an open review and sends the confirmed revision', async () => {
    const updateResearch = vi.fn().mockResolvedValue(detailFixture)
    const getResearch = vi.fn()
      .mockResolvedValueOnce(detailFixture)
      .mockResolvedValue({ ...detailFixture, revision: 3 })
    const api = fakeApi({
      getResearch,
      updateResearch,
      listResearchImports: vi.fn().mockResolvedValue([imported]),
      getResearchImport: vi.fn().mockResolvedValue(importDetail),
    })
    const { rerender, props } = mount({ api })
    await openDiscussion()
    fireEvent.click(await importSection().findByRole('button', { name: /kubecode.research.import.reviewItem/ }))
    const constraint = await importSection().findByRole('checkbox', { name: /No more than 4 GPUs/ })
    fireEvent.click(constraint)
    const apply = () => importSection().getByRole('button', { name: /kubecode.research.import.apply/ })
    expect(apply()).toBeEnabled()

    // A colleague's edit lands: the proposal must not silently rebase onto it.
    rerender(<ResearchWorkspace {...props} events={[event(1)]} />)
    expect(await importSection().findByText(/kubecode.research.import.briefChanged/)).toHaveTextContent('"revision":3')
    expect(constraint).toBeChecked()
    expect(apply()).toBeDisabled()
    expect(apply()).toHaveTextContent('"from":2')

    fireEvent.click(importSection().getByRole('button', { name: /kubecode.research.import.reReview/ }))
    expect(apply()).toBeEnabled()
    fireEvent.click(apply())
    await waitFor(() => expect(updateResearch).toHaveBeenCalledTimes(1))
    expect(updateResearch.mock.calls[0].slice(0, 3)).toEqual(['p1', 'rq-1', 3])
  })

  it('refreshes after a partial apply and records each decision under its own key', async () => {
    const updateResearch = vi.fn().mockResolvedValue(detailFixture)
    const addResearchEntry = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('down'))
    const getResearch = vi.fn().mockResolvedValue(detailFixture)
    const twoDecisions: ResearchImportDetail = {
      ...importDetail,
      candidates: [
        { kind: 'decision', text: 'Alpha decision', line: 2 },
        { kind: 'decision', text: 'Bravo decision', line: 3 },
        { kind: 'constraint', text: 'No more than 4 GPUs', line: 4 },
      ],
    }
    mount({
      api: fakeApi({
        getResearch,
        updateResearch,
        addResearchEntry,
        listResearchImports: vi.fn().mockResolvedValue([imported]),
        getResearchImport: vi.fn().mockResolvedValue(twoDecisions),
      }),
    })
    await openDiscussion()
    fireEvent.click(await importSection().findByRole('button', { name: /kubecode.research.import.reviewItem/ }))
    for (const name of [/Alpha decision/, /Bravo decision/, /No more than 4 GPUs/]) {
      fireEvent.click(await importSection().findByRole('checkbox', { name }))
    }
    const before = getResearch.mock.calls.length
    fireEvent.click(importSection().getByRole('button', { name: /kubecode.research.import.apply/ }))
    await waitFor(() => expect(addResearchEntry).toHaveBeenCalledTimes(2))
    // The brief edit landed before a later step failed, so the view reloads.
    await waitFor(() => expect(getResearch.mock.calls.length).toBeGreaterThan(before))
    const keys = addResearchEntry.mock.calls.map((call) => call[4])
    expect(new Set(keys).size).toBe(2)
    expect(await importSection().findAllByRole('alert')).not.toHaveLength(0)
  })

  it('shows a failed import list with a retry instead of an empty list', async () => {
    const listResearchImports = vi.fn().mockRejectedValue(new Error('down'))
    mount({ api: fakeApi({ listResearchImports }) })
    await openDiscussion()
    expect(await importSection().findByText('kubecode.research.import.listFailed')).toBeInTheDocument()
    expect(importSection().queryByText('kubecode.research.import.empty')).not.toBeInTheDocument()
    const before = listResearchImports.mock.calls.length
    fireEvent.click(importSection().getByRole('button', { name: 'kubecode.retry' }))
    await waitFor(() => expect(listResearchImports.mock.calls.length).toBeGreaterThan(before))
  })

  it('does not reuse an import key once the text changes after a failed attempt', async () => {
    const createResearchImport = vi.fn()
      .mockRejectedValueOnce(new ApiError('internal_error', 'down', 500))
      .mockResolvedValue({ ...imported, created: true })
    mount({ api: fakeApi({ createResearchImport, listResearchImports: vi.fn().mockResolvedValue([]) }) })
    await openDiscussion()
    const label = await importSection().findByLabelText('kubecode.research.import.label')
    fireEvent.change(label, { target: { value: 'Thread' } })
    fireEvent.change(importSection().getByLabelText('kubecode.research.import.text'), { target: { value: 'first text' } })
    fireEvent.click(importSection().getByRole('button', { name: 'kubecode.research.import.submit' }))
    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(1))
    await screen.findAllByRole('alert')
    fireEvent.change(importSection().getByLabelText('kubecode.research.import.text'), { target: { value: 'edited text' } })
    fireEvent.click(importSection().getByRole('button', { name: 'kubecode.research.import.submit' }))
    await waitFor(() => expect(createResearchImport).toHaveBeenCalledTimes(2))
    expect(createResearchImport.mock.calls[1][2].client_request_id)
      .not.toBe(createResearchImport.mock.calls[0][2].client_request_id)
  })

  it('drops a packet built for other checkboxes and one made for an older revision', async () => {
    let resolveSlow: (packet: unknown) => void = () => {}
    const exportResearchPacket = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveSlow = resolve
    }))
    mount({ api: fakeApi({ exportResearchPacket, listResearchImports: vi.fn().mockResolvedValue([]) }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    const exportSection = within(await screen.findByRole('region', { name: 'kubecode.research.export.title' }))
    fireEvent.click(exportSection.getByRole('button', { name: 'kubecode.research.export.preview' }))
    await waitFor(() => expect(exportResearchPacket).toHaveBeenCalledTimes(1))
    // The selection changes while the build is in flight.
    fireEvent.click(exportSection.getByRole('checkbox', { name: 'kubecode.research.export.section.evidence' }))
    resolveSlow({
      research_id: 'rq-1', brief_revision: 2, sections: [], markdown: 'STALE PACKET',
      total_bytes: 12, truncated: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(exportSection.queryByDisplayValue('STALE PACKET')).not.toBeInTheDocument()
  })

  it('warns instead of offering a packet whose revision is no longer the approved one', async () => {
    const exportResearchPacket = vi.fn().mockResolvedValue({
      research_id: 'rq-1', brief_revision: 1, sections: [], markdown: 'OLD', total_bytes: 3, truncated: false,
    })
    mount({ api: fakeApi({ exportResearchPacket, listResearchImports: vi.fn().mockResolvedValue([]) }) })
    await screen.findByText('Does structured pruning keep accuracy?')
    openTab('kubecode.research.tab.discussion')
    const exportSection = within(await screen.findByRole('region', { name: 'kubecode.research.export.title' }))
    fireEvent.click(exportSection.getByRole('button', { name: 'kubecode.research.export.preview' }))
    expect(await exportSection.findByText('kubecode.research.export.outdated')).toBeInTheDocument()
    expect(exportSection.queryByRole('button', { name: 'kubecode.research.export.copy' })).not.toBeInTheDocument()
  })
})
