import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError, type AttentionSnapshot, type KubecodeApi } from '../api'
import { fakeNavigation } from '../app/inspector/inspectorTesting'
import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { AttentionContext, type AttentionStore } from './attentionContext'
import { execution, failure, inputItem, permissionItem, snapshot } from './attentionFixtures'
import { ExecutionStrip, type ExecutionStripProps } from './ExecutionStrip'

const t = createTranslator('en')

function store(value: AttentionSnapshot, overrides: Partial<AttentionStore> = {}): AttentionStore {
  const scoped = <T extends { binding: string | null; member: { id: string } | null; tasks?: { id: string }[] }>(
    list: T[],
    scope: Parameters<AttentionStore['executions']>[0],
  ) => list.filter((entry) => ('taskId' in scope
    ? entry.tasks?.some((task) => task.id === scope.taskId)
    : scope.binding === 'public' ? entry.binding === 'public' : entry.binding === 'dm' && entry.member?.id === scope.memberId))
  return {
    projectId: 'p1',
    snapshot: value,
    status: 'ready',
    forTask: () => [],
    byKey: (key) => value.items.find((item) => item.key === key),
    executions: (scope) => scoped(value.executions, scope),
    failures: (scope) => scoped(value.failures, scope),
    resolving: new Set(),
    markResolving: vi.fn((_key, call) => call()),
    reload: vi.fn(),
    ...overrides,
  }
}

function strip(value: AttentionStore, props: Partial<ExecutionStripProps> = {}, api: Partial<KubecodeApi> = {}, navigation: WorkspaceNavigation | null = null) {
  const client = {
    cancelRun: vi.fn().mockResolvedValue(undefined),
    taskDetail: vi.fn().mockResolvedValue({ id: 'r1', execution: { round_id: 'round1', round_number: 1, paused: false, policy_revision: 3 } }),
    setRoundExecutionPolicy: vi.fn().mockResolvedValue(undefined),
    resolvePermission: vi.fn().mockResolvedValue(undefined),
    resolveElicitation: vi.fn().mockResolvedValue(undefined),
    ...api,
  } as unknown as KubecodeApi
  const view = render(
    <WorkspaceNavigationContext.Provider value={navigation}>
      <AttentionContext.Provider value={value}>
        <ExecutionStrip api={client} scope={{ binding: 'public' }} t={t} {...props} />
      </AttentionContext.Provider>
    </WorkspaceNavigationContext.Provider>,
  )
  return { ...view, api: client }
}

describe('ExecutionStrip', () => {
  it('names each member at work and what on, with one Stop that stops the whole Task', async () => {
    const value = store(snapshot({ executions: [execution({ queued: 2 })] }))
    const { api } = strip(value)
    const region = screen.getByRole('region', { name: 'Working now' })
    expect(region).toHaveTextContent('Analyst')
    expect(region).toHaveTextContent('2 queued')
    // Work in progress shimmers, in words (AI Elements Shimmer, #232).
    expect(region.querySelector('.kubecode-shimmer')).toHaveTextContent('Structured pruning')
    // One run is one compact row, never folded behind a count.
    expect(within(region).queryByRole('button', { name: /running/ })).not.toBeInTheDocument()
    const stop = within(region).getByRole('button', { name: 'Stop Structured pruning' })
    expect(stop).toHaveAccessibleDescription(/pauses new work on Structured pruning/)
    fireEvent.click(stop)
    fireEvent.click(stop)
    // Stop pauses the Task first, so nothing new is handed out, then ends the turn.
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledTimes(1))
    expect(api.taskDetail).toHaveBeenCalledWith('p1', 'r1')
    expect(api.setRoundExecutionPolicy).toHaveBeenCalledWith('p1', 'round1', 3, { paused: true })
    expect(api.cancelRun).toHaveBeenCalledWith('run1')
    expect(region).toHaveTextContent('Stopping…')
    expect(within(region).getByRole('button', { name: 'Stop Structured pruning' })).toHaveAttribute('aria-busy', 'true')
    expect(value.reload).toHaveBeenCalled()
  })

  it('does not pause a Task twice when new work on it is already paused', async () => {
    const { api } = strip(store(snapshot({ executions: [execution()] })), {}, {
      taskDetail: vi.fn().mockResolvedValue({ id: 'r1', execution: { round_id: 'round1', round_number: 1, paused: true, policy_revision: 4 } }),
    } as Partial<KubecodeApi>)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Structured pruning' }))
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith('run1'))
    expect(api.setRoundExecutionPolicy).not.toHaveBeenCalled()
  })

  it('reads the Task again and pauses once more when its limits changed elsewhere meanwhile', async () => {
    const setRoundExecutionPolicy = vi.fn()
      .mockRejectedValueOnce(new ApiError('policy_revision_conflict', 'changed', 409))
      .mockResolvedValueOnce(undefined)
    const taskDetail = vi.fn()
      .mockResolvedValueOnce({ id: 'r1', execution: { round_id: 'round1', round_number: 1, paused: false, policy_revision: 3 } })
      .mockResolvedValueOnce({ id: 'r1', execution: { round_id: 'round1', round_number: 1, paused: false, policy_revision: 5 } })
    const { api } = strip(store(snapshot({ executions: [execution()] })), {}, { setRoundExecutionPolicy, taskDetail } as Partial<KubecodeApi>)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Structured pruning' }))
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith('run1'))
    expect(setRoundExecutionPolicy).toHaveBeenLastCalledWith('p1', 'round1', 5, { paused: true })
  })

  it('does not end the turns when the Task could not be paused', async () => {
    const { api } = strip(store(snapshot({ executions: [execution()] })), {}, {
      setRoundExecutionPolicy: vi.fn().mockRejectedValue(new ApiError('forbidden', 'no', 403)),
    } as Partial<KubecodeApi>)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Structured pruning' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Structured pruning could not be stopped. Try again.'))
    expect(api.cancelRun).not.toHaveBeenCalled()
  })

  it('stops every turn on one Task from its one row', async () => {
    const runs = [execution(), execution({ run_id: 'run2', conversation_id: 's2', member: { id: 'm2', name: 'Coder', handle: 'coder', role: 'specialist' } })]
    const { api } = strip(store(snapshot({ executions: runs })))
    expect(screen.getAllByRole('button', { name: 'Stop Structured pruning' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Structured pruning' }))
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledTimes(2))
    expect(api.setRoundExecutionPolicy).toHaveBeenCalledTimes(1)
  })

  it('announces a Stop that failed and frees its button', async () => {
    const value = store(snapshot({ executions: [execution()] }))
    strip(value, {}, { cancelRun: vi.fn().mockRejectedValue(new Error('nope')) } as Partial<KubecodeApi>)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Structured pruning' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Structured pruning could not be stopped. Try again.'))
    expect(screen.getByRole('button', { name: 'Stop Structured pruning' })).not.toHaveAttribute('aria-busy')
    expect(value.reload).toHaveBeenCalled()
  })

  it('folds more than one running Task into one count that opens the list, each with its member and Stop', async () => {
    const other = { id: 'r2', title: 'Quantization' }
    const runs = [
      execution(),
      execution({ run_id: 'run2', conversation_id: 's2', tasks: [other], member: { id: 'm2', name: 'Coder', handle: 'coder', role: 'specialist' } }),
      execution({ run_id: 'run3', conversation_id: 's3', tasks: [] }),
    ]
    const item = permissionItem()
    strip(store(snapshot({ items: [item], executions: runs })))
    const region = screen.getByRole('region', { name: 'Working now' })
    expect(within(region).queryByRole('button', { name: /^Stop/ })).not.toBeInTheDocument()
    // A decision is never folded away.
    expect(within(region).getByTestId('permission-queue-card')).toBeVisible()
    const toggle = within(region).getByRole('button', { name: '3 running' })
    fireEvent.click(toggle)
    const list = await screen.findByRole('dialog', { name: 'Working now' })
    // The list is the official Queue (ADR 0242): one section, each piece of work an Item with its Stop.
    expect(within(list).getByRole('button', { name: /3 running/ })).toHaveAttribute('data-state', 'open')
    expect(list.querySelectorAll('li [data-slot="item"]')).toHaveLength(3)
    expect(within(list).getByText('Coder')).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Stop Structured pruning' })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Stop Quantization' })).toBeInTheDocument()
    // A turn not tied to a Task stops only its reply.
    expect(within(list).getByRole('button', { name: "Stop Analyst's reply" })).toBeInTheDocument()
    // Focus lands on the list, so Escape closes it at once.
    expect(list).toHaveFocus()
    fireEvent.keyDown(list, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('opens the running list without a focus ring when opened by a pointer, and with one from the keyboard', async () => {
    const runs = [execution(), execution({ run_id: 'run2', conversation_id: 's2', tasks: [] })]
    strip(store(snapshot({ executions: runs })))
    const toggle = screen.getByRole('button', { name: '2 running' })
    fireEvent.pointerDown(toggle)
    fireEvent.click(toggle)
    const list = await screen.findByRole('dialog', { name: 'Working now' })
    expect(list).toHaveAttribute('data-opened-by', 'pointer')
    expect(list).toHaveFocus()
    fireEvent.keyDown(list, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.keyDown(toggle, { key: 'Enter' })
    fireEvent.click(toggle)
    expect(await screen.findByRole('dialog', { name: 'Working now' })).toHaveAttribute('data-opened-by', 'keyboard')
  })

  it('names the reply it stops in a private conversation, and only ends that reply', async () => {
    const value = store(snapshot({ executions: [execution({ binding: 'dm', conversation_id: 'dm1', tasks: [] })] }))
    const { api } = strip(value, { scope: { binding: 'dm', memberId: 'm1' } })
    fireEvent.click(screen.getByRole('button', { name: "Stop Analyst's reply" }))
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith('run1'))
    expect(api.taskDetail).not.toHaveBeenCalled()
  })

  it('says a Task was stopped once its turn leaves the snapshot', async () => {
    const value = store(snapshot({ executions: [execution()] }))
    const { rerender } = strip(value)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Structured pruning' }))
    await act(async () => undefined)
    const next = store(snapshot({ cursor: 2 }))
    rerender(
      <WorkspaceNavigationContext.Provider value={null}>
        <AttentionContext.Provider value={next}>
          <ExecutionStrip api={{ cancelRun: vi.fn() } as unknown as KubecodeApi} scope={{ binding: 'public' }} t={t} />
        </AttentionContext.Provider>
      </WorkspaceNavigationContext.Provider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Stopped Structured pruning')
  })

  it('shows the permission a member waits on, answered in place through the attention store', async () => {
    const item = permissionItem()
    const value = store(snapshot({
      items: [item],
      executions: [execution({ status: 'waiting_permission', waiting_keys: [item.key] })],
    }))
    const { api } = strip(value)
    expect(screen.getByText(/Waiting for your permission/)).toBeInTheDocument()
    const prompt = screen.getByTestId('permission-queue-card')
    expect(prompt).toHaveAttribute('data-focus-key', 'permission:q1')
    expect(prompt).toHaveTextContent('Analyst asks permission · For Structured pruning')
    fireEvent.click(within(prompt).getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(api.resolvePermission).toHaveBeenCalledWith('q1', 'allow'))
    expect(value.markResolving).toHaveBeenCalledWith('permission:q1', expect.any(Function))
  })

  it('answers a member\'s request for input in its private conversation', async () => {
    const item = inputItem()
    const value = store(snapshot({ items: [item], executions: [execution({ binding: 'dm', waiting_keys: [item.key] })] }))
    const { api } = strip(value, { scope: { binding: 'dm', memberId: 'm1' } })
    fireEvent.change(screen.getByLabelText('Split'), { target: { value: 'val' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    await waitFor(() => expect(api.resolveElicitation).toHaveBeenCalledWith('e1', { split: 'val' }))
  })

  it('leaves prompts to General and the DM when it shows a Task\'s work', () => {
    const item = permissionItem()
    const value = store(snapshot({ items: [item], executions: [execution({ waiting_keys: [item.key] })] }))
    strip(value, { scope: { taskId: 'r1' }, prompts: false })
    expect(screen.queryByTestId('permission-queue-card')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop Structured pruning' })).toBeInTheDocument()
  })

  it('shows a member\'s failed turn once, until dismissed', () => {
    const value = store(snapshot({ failures: [failure()] }))
    strip(value)
    expect(screen.getByText("Analyst's last turn failed")).toBeInTheDocument()
    expect(screen.getByText("Analyst's last turn failed").closest('[data-slot="alert"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText("Analyst's last turn failed")).not.toBeInTheDocument()
  })

  it('counts one queued message as a small count', () => {
    strip(store(snapshot({ executions: [execution({ queued: 1 })] })))
    expect(screen.getByRole('region', { name: 'Working now' })).toHaveTextContent('1 queued')
  })

  it('keeps an answered prompt busy until the server drops it: no button or 1–9 key answers it twice', () => {
    const item = permissionItem()
    const value = store(snapshot({ items: [item], executions: [execution({ waiting_keys: [item.key] })] }), { resolving: new Set([item.key]) })
    const { api } = strip(value)
    const prompt = screen.getByTestId('permission-queue-card')
    expect(prompt).toHaveTextContent('Answer recorded — updating…')
    const allow = within(prompt).getByRole('button', { name: 'Allow' })
    expect(allow).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(allow)
    fireEvent.keyDown(prompt, { key: '1' })
    expect(api.resolvePermission).not.toHaveBeenCalled()
  })

  it('keeps an answered input request busy until the server drops it', () => {
    const item = inputItem()
    const value = store(snapshot({ items: [item] }), { resolving: new Set([item.key]) })
    const { api } = strip(value, { scope: { binding: 'dm', memberId: 'm1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(api.resolveElicitation).not.toHaveBeenCalled()
    expect(screen.getByText('Answer recorded — updating…')).toBeInTheDocument()
  })

  it('says a turn waits for its Team leader, not for the researcher, when no request is the researcher\'s', () => {
    strip(store(snapshot({ executions: [execution({ status: 'waiting_permission', waiting_keys: [] })] })))
    expect(screen.getByText(/Waiting for the Team leader/)).toBeInTheDocument()
    expect(screen.queryByText(/Waiting for your permission/)).not.toBeInTheDocument()
  })

  it('offers a step for a failed turn: the member in Members, where its Session and setup are', () => {
    const navigation = fakeNavigation()
    strip(store(snapshot({ failures: [failure()] })), {}, {}, navigation)
    fireEvent.click(screen.getByRole('button', { name: 'Open Analyst in Members' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'members' }, { inspect: { kind: 'member', id: 'm1' } })
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('on a phone, keeps its prompts in a capped, scrollable body', () => {
    const first = permissionItem()
    const second = permissionItem({ request_id: 'q2', key: 'permission:q2', tool: 'Run make' })
    strip(store(snapshot({
      items: [first, second],
      executions: [execution({ status: 'waiting_permission', waiting_keys: [first.key, second.key] })],
    })))
    const region = screen.getByRole('region', { name: 'Working now' })
    const body = within(region).getByRole('group', { name: 'Waiting for you' })
    expect(body).toHaveClass('kubecode-execution-body')
    expect(within(body).getAllByTestId('permission-queue-card')).toHaveLength(2)
  })

  it('renders nothing when nobody is at work', () => {
    const { container } = strip(store(snapshot()))
    expect(container).toBeEmptyDOMElement()
  })
})
