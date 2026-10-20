import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { AttentionSnapshot, KubecodeApi } from '../api'
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
  it('names each member at work, what on, and a Stop that says whose turn it ends', async () => {
    const value = store(snapshot({ executions: [execution({ queued: 2 })] }))
    const { api } = strip(value)
    const region = screen.getByRole('region', { name: 'Working now' })
    expect(region).toHaveTextContent('Analyst is working on Structured pruning')
    expect(region).toHaveTextContent('2 more messages queued')
    const stop = within(region).getByRole('button', { name: "Stop Analyst's current turn" })
    expect(stop).toHaveAccessibleDescription(/Work assigned to Analyst stays open/)
    fireEvent.click(stop)
    fireEvent.click(stop)
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledTimes(1))
    expect(api.cancelRun).toHaveBeenCalledWith('run1')
    expect(region).toHaveTextContent('Stopping…')
  })

  it('names the reply it stops in a private conversation', () => {
    const value = store(snapshot({ executions: [execution({ binding: 'dm', conversation_id: 'dm1' })] }))
    strip(value, { scope: { binding: 'dm', memberId: 'm1' } })
    expect(screen.getByRole('button', { name: "Stop Analyst's reply" })).toBeInTheDocument()
  })

  it('says a turn was stopped once it leaves the snapshot', async () => {
    const value = store(snapshot({ executions: [execution()] }))
    const { rerender } = strip(value)
    fireEvent.click(screen.getByRole('button', { name: "Stop Analyst's current turn" }))
    await act(async () => undefined)
    const next = store(snapshot({ cursor: 2 }))
    rerender(
      <WorkspaceNavigationContext.Provider value={null}>
        <AttentionContext.Provider value={next}>
          <ExecutionStrip api={{ cancelRun: vi.fn() } as unknown as KubecodeApi} scope={{ binding: 'public' }} t={t} />
        </AttentionContext.Provider>
      </WorkspaceNavigationContext.Provider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent("Stopped Analyst's turn")
  })

  it('shows the permission a member waits on, answered in place through the attention store', async () => {
    const item = permissionItem()
    const value = store(snapshot({
      items: [item],
      executions: [execution({ status: 'waiting_permission', waiting_keys: [item.key] })],
    }))
    const { api } = strip(value)
    expect(screen.getByText('Analyst is waiting for your permission')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: "Stop Analyst's current turn" })).toBeInTheDocument()
  })

  it('folds more than two quiet rows, but never one that waits on the researcher', () => {
    const item = permissionItem()
    const others = ['a', 'b', 'c'].map((id) => execution({
      run_id: `run-${id}`, conversation_id: `s-${id}`, member: { id, name: `Member ${id}`, handle: id, role: 'specialist' }, tasks: [],
    }))
    const value = store(snapshot({
      items: [item],
      executions: [execution({ waiting_keys: [item.key], status: 'waiting_permission' }), ...others],
    }))
    strip(value)
    const folded = screen.getByText('3 working now').closest('details') as HTMLElement
    expect(folded).not.toHaveAttribute('open')
    expect(within(folded).getByText('Member a is working')).toBeInTheDocument()
    expect(folded).not.toContainElement(screen.getByTestId('permission-queue-card'))
  })

  it('shows a member\'s failed turn once, until dismissed', () => {
    const value = store(snapshot({ failures: [failure()] }))
    strip(value)
    expect(screen.getByText("Analyst's last turn failed")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText("Analyst's last turn failed")).not.toBeInTheDocument()
  })

  it('counts one queued message in the singular', () => {
    strip(store(snapshot({ executions: [execution({ queued: 1 })] })))
    expect(screen.getByRole('region', { name: 'Working now' })).toHaveTextContent('1 more message queued')
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
    expect(screen.getByText("Analyst is waiting for the Team leader's answer")).toBeInTheDocument()
    expect(screen.queryByText('Analyst is waiting for your permission')).not.toBeInTheDocument()
  })

  it('offers a step for a failed turn: the member in Members, where its Session and setup are', () => {
    const navigation = fakeNavigation()
    strip(store(snapshot({ failures: [failure()] })), {}, {}, navigation)
    fireEvent.click(screen.getByRole('button', { name: 'Open Analyst in Members' }))
    expect(navigation.openPlace).toHaveBeenCalledWith({ view: 'members' }, { inspect: { kind: 'member', id: 'm1' } })
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('on a phone, sums itself up in one line and keeps its prompts in a capped, scrollable body', () => {
    const first = permissionItem()
    const second = permissionItem({ request_id: 'q2', key: 'permission:q2', tool: 'Run make' })
    strip(store(snapshot({
      items: [first, second],
      executions: [execution({ status: 'waiting_permission', waiting_keys: [first.key, second.key] })],
    })))
    const region = screen.getByRole('region', { name: 'Working now' })
    expect(region.querySelector('.kubecode-execution-summary')).toHaveTextContent('Working now: 1 · Waiting for you: 2')
    const body = within(region).getByRole('group', { name: 'Working now' })
    expect(body).toHaveClass('kubecode-execution-body')
    expect(within(body).getAllByTestId('permission-queue-card')).toHaveLength(2)
  })

  it('renders nothing when nobody is at work', () => {
    const { container } = strip(store(snapshot()))
    expect(container).toBeEmptyDOMElement()
  })
})
