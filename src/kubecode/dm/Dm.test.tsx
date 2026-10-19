import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DmTurn, KubecodeApi, Member, ResearchSummary, WorkspaceEvent } from '../api'
import { ApiError } from '../api'
import { DmPane } from './DmPane'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const analyst: Member = {
  id: 'm1', project_id: 'p1', role: 'specialist', template: 'analysis', name: 'Analyst',
  handle: 'analyst', spec: { agent_id: 'opencode', config: {}, instructions: '' },
  public_conversation_id: 's-public', dm_conversation_id: 's-dm', state: 'active',
  setup_error: null, setup_code: null, revision: 1, created_at: '', updated_at: '', removed_at: null,
}

const research = [{ id: 'r1', title: 'Pruning' }] as unknown as ResearchSummary[]

const turn = (id: string, user: string, assistant: string): DmTurn => ({ run_id: id, user, assistant })

function setup(overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}, events: WorkspaceEvent[] = []) {
  const api = {
    memberDmTurns: vi.fn().mockResolvedValue([
      turn('run-1', 'is 0.91 enough?', 'It is within a point.'),
      turn('run-2', 'what about the reviewer?', 'Mention it to them.'),
    ]),
    sendMemberDm: vi.fn().mockResolvedValue(undefined),
    previewDmShare: vi.fn().mockResolvedValue({ text: 'EXACT TEXT', digest: 'd1', task_id: null }),
    shareDm: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
  const onShared = vi.fn()
  const view = render(
    <DmPane
      api={api as unknown as KubecodeApi}
      connectionState="live"
      events={events}
      member={analyst}
      projectId="p1"
      research={research}
      t={t}
      onClose={vi.fn()}
      onShared={onShared}
    />,
  )
  return { api, onShared, view }
}

const titled = (name: string) => `${name}:{"name":"Analyst"}`

describe('DmPane', () => {
  it('shows the private conversation, says who can see it, and sends privately', async () => {
    const { api } = setup()
    expect(await screen.findByText('is 0.91 enough?')).toBeInTheDocument()
    expect(screen.getByText('It is within a point.')).toBeInTheDocument()
    expect(screen.getByText(titled('kubecode.dm.private'))).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: titled('kubecode.dm.placeholder') })
    fireEvent.change(box, { target: { value: 'my private plan' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(api.sendMemberDm).toHaveBeenCalledTimes(1))
    expect(api.sendMemberDm).toHaveBeenCalledWith('p1', 'm1', 'my private plan', expect.any(String))
    await waitFor(() => expect(box).toHaveValue(''))
  })

  it('keeps one client id across a failed send, reports why, and starts a new one for new words', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new ApiError('dm_failed', 'x', 502))
      .mockRejectedValueOnce(new ApiError('dm_busy', 'x', 409))
      .mockResolvedValue(undefined)
    setup({ sendMemberDm: send })
    await screen.findByText('is 0.91 enough?')
    const box = screen.getByRole('textbox', { name: titled('kubecode.dm.placeholder') })
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.dm.failed')
    expect(box).toHaveValue('hello')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.dm.busy')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    expect(send.mock.calls[1][3]).toBe(send.mock.calls[0][3])
    expect(send.mock.calls[2][3]).toBe(send.mock.calls[0][3])
    await waitFor(() => expect(box).toHaveValue(''))
    fireEvent.change(box, { target: { value: 'something else' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4))
    expect(send.mock.calls[3][3]).not.toBe(send.mock.calls[0][3])
  })

  it('refreshes from the DM Session events only, and offers a retry when the turns cannot load', async () => {
    const turns = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([turn('run-1', 'is 0.91 enough?', 'ok')])
    const { api, view } = setup({ memberDmTurns: turns })
    expect(await screen.findByRole('alert')).toHaveTextContent('kubecode.dm.loadFailed')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.retry' }))
    expect(await screen.findByText('is 0.91 enough?')).toBeInTheDocument()
    const before = turns.mock.calls.length
    const event = (id: number, conversation: string): WorkspaceEvent => ({
      id, kind: 'agent_event', project_id: 'p1', conversation_id: conversation, run_id: null,
      payload: {}, created_at: '',
    })
    const rerender = (events: WorkspaceEvent[]) => view.rerender(
      <DmPane
        api={api as unknown as KubecodeApi}
        connectionState="live"
        events={events}
        member={analyst}
        projectId="p1"
        research={research}
        t={t}
        onClose={vi.fn()}
      />,
    )
    rerender([event(1, 's-public')])
    expect(turns.mock.calls.length).toBe(before)
    rerender([event(1, 's-public'), event(2, 's-dm')])
    await waitFor(() => expect(turns.mock.calls.length).toBe(before + 1))
  })

  it('shares only the chosen turns after showing the exact text, and any change needs a new preview', async () => {
    const { api, onShared } = setup()
    await screen.findByText('is 0.91 enough?')
    fireEvent.click(screen.getByRole('button', { name: /kubecode.dm.share$/ }))
    const dialog = await screen.findByRole('dialog')
    // Nothing is chosen, so nothing can be previewed.
    expect(within(dialog).getByRole('button', { name: 'kubecode.dm.sharePreviewAction' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'for everyone' } })
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'r1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.sharePreviewAction' }))
    expect(await within(dialog).findByText('EXACT TEXT')).toBeInTheDocument()
    expect(api.previewDmShare).toHaveBeenCalledWith('p1', 'm1', {
      runIds: ['run-1'], note: 'for everyone', taskId: 'r1',
    })
    // Editing the note makes the preview stale: it must be shown again.
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'for everyone!' } })
    expect(within(dialog).queryByText('EXACT TEXT')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'kubecode.dm.shareConfirm' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.sharePreviewAction' }))
    await within(dialog).findByText('EXACT TEXT')
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.shareConfirm' }))
    await waitFor(() => expect(api.shareDm).toHaveBeenCalledWith('p1', 'm1', {
      runIds: ['run-1'], note: 'for everyone!', taskId: 'r1', digest: 'd1', clientMessageId: expect.any(String),
    }))
    await waitFor(() => expect(onShared).toHaveBeenCalled())
    expect(await screen.findByText('kubecode.dm.shared')).toBeInTheDocument()
  })

  it('drops the preview when the server says the conversation changed, and bounds the turns', async () => {
    const many = Array.from({ length: 8 }, (_, index) => turn(`run-${index}`, `question ${index}`, 'a'))
    const share = vi.fn().mockRejectedValue(new ApiError('dm_share_stale', 'x', 409))
    const { api } = setup({ memberDmTurns: vi.fn().mockResolvedValue(many), shareDm: share })
    await screen.findByText('question 0')
    fireEvent.click(screen.getByRole('button', { name: /kubecode.dm.share$/ }))
    const dialog = await screen.findByRole('dialog')
    for (let index = 0; index < 8; index += 1) {
      fireEvent.click(within(dialog).getByRole('checkbox', { name: new RegExp(`question ${index}$`) }))
    }
    expect(within(dialog).getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).checked)).toHaveLength(6)
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.sharePreviewAction' }))
    await within(dialog).findByText('EXACT TEXT')
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.shareConfirm' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('kubecode.dm.shareStale')
    expect(within(dialog).queryByText('EXACT TEXT')).not.toBeInTheDocument()
    expect(api.previewDmShare).toHaveBeenCalledTimes(1)
  })

  it('forgets the selection when closed, and a second share is a new message', async () => {
    const share = vi.fn().mockResolvedValue({})
    const { api } = setup({ shareDm: share })
    await screen.findByText('is 0.91 enough?')
    const open = async () => {
      fireEvent.click(screen.getByRole('button', { name: /kubecode.dm.share$/ }))
      return screen.findByRole('dialog')
    }
    let dialog = await open()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.sharePreviewAction' }))
    await within(dialog).findByText('EXACT TEXT')
    fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.members.cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    dialog = await open()
    // Reopened: nothing chosen, no stale preview that could be confirmed.
    expect(within(dialog).queryByText('EXACT TEXT')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'kubecode.dm.sharePreviewAction' })).toBeDisabled()
    // Share the same turn twice on purpose: two confirmations, two ids.
    for (let round = 0; round < 2; round += 1) {
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.sharePreviewAction' }))
      await within(dialog).findByText('EXACT TEXT')
      fireEvent.click(within(dialog).getByRole('button', { name: 'kubecode.dm.shareConfirm' }))
      await waitFor(() => expect(share).toHaveBeenCalledTimes(round + 1))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      if (round === 0) dialog = await open()
    }
    expect(share.mock.calls[0][2].clientMessageId).not.toBe(share.mock.calls[1][2].clientMessageId)
    expect(api.previewDmShare).toHaveBeenCalledTimes(3)
  })
})
