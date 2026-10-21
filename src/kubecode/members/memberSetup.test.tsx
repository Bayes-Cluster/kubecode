import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation, KubecodeApi } from '../api'
import { ManagerSetupNotice } from './ManagerSetupNotice'
import { general, member } from './memberFixtures'
import { lockedManagerOption, managerSetup, memberActivity } from './memberModel'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

describe('managerSetup', () => {
  it('is unknown until the roster loads, then ready, missing, or waiting on setup', () => {
    expect(managerSetup(null)).toEqual({ kind: 'unknown' })
    expect(managerSetup({ members: [general], general_id: general.id })).toEqual({ kind: 'ready', manager: general })
    expect(managerSetup({ members: [], general_id: null })).toEqual({ kind: 'missing' })
    const broken = { ...general, state: 'setup_required' as const, setup_code: 'provider_unavailable' as const }
    expect(managerSetup({ members: [broken], general_id: general.id })).toEqual({ kind: 'needs_setup', manager: broken })
  })
})

describe('memberActivity', () => {
  const session = (status: Conversation['latest_run_status']) => [{ id: 's-g', latest_run_status: status }] as Conversation[]
  it('reads execution from the member\'s Session, never from membership', () => {
    const working = { ...general, public_conversation_id: 's-g' }
    expect(memberActivity(working, session('running'))).toBe('running')
    expect(memberActivity(working, session('waiting_permission'))).toBe('waiting')
    expect(memberActivity(working, session('completed'))).toBeNull()
    expect(memberActivity({ ...working, public_conversation_id: null }, session('running'))).toBeNull()
  })
})

describe('lockedManagerOption', () => {
  it('refuses a mode option for the project manager in any spelling', () => {
    expect(lockedManagerOption([{ key: 'model', value: 'fast' }])).toBeNull()
    expect(lockedManagerOption([{ key: ' Mode ', value: 'build' }])).toBe(' Mode ')
    expect(lockedManagerOption([{ key: 'permission_mode', value: 'x' }])).toBe('permission_mode')
  })
})

describe('ManagerSetupNotice', () => {
  const api = (overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}) => ({
    retryMemberSetup: vi.fn().mockResolvedValue({}),
    ...overrides,
  }) as unknown as KubecodeApi

  it('says nothing while the manager is ready or the roster is loading', () => {
    const { container, rerender } = render(
      <ManagerSetupNotice api={api()} projectId="p1" setup={{ kind: 'ready', manager: general }} t={t} onOpenMembers={vi.fn()} onReload={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<ManagerSetupNotice api={api()} projectId="p1" setup={{ kind: 'unknown' }} t={t} onOpenMembers={vi.fn()} onReload={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names why the manager is not ready and recovers it in place', async () => {
    const client = api()
    const onReload = vi.fn()
    const onOpenMembers = vi.fn()
    const manager = member({ ...general, state: 'setup_required', setup_code: 'provider_unavailable' })
    render(
      <ManagerSetupNotice
        api={client}
        projectId="p1"
        setup={{ kind: 'needs_setup', manager }}
        t={t}
        onOpenMembers={onOpenMembers}
        onReload={onReload}
      />,
    )
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('kubecode.members.managerSetup.title')
    expect(notice).toHaveTextContent('kubecode.members.setup.providerUnavailable:{"provider":"OpenCode"}')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.retrySetup' }))
    await waitFor(() => expect(client.retryMemberSetup).toHaveBeenCalledWith('p1', general.id))
    await waitFor(() => expect(onReload).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.managerSetup.openMembers' }))
    expect(onOpenMembers).toHaveBeenCalledWith(general.id)
  })

  it('keeps a failed retry visible, and points a missing manager at Members', async () => {
    const client = api({ retryMemberSetup: vi.fn().mockRejectedValue(new Error('still broken')) })
    const manager = member({ ...general, state: 'setup_required', setup_code: 'config_rejected', setup_error: 'bad model' })
    const { rerender } = render(
      <ManagerSetupNotice api={client} projectId="p1" setup={{ kind: 'needs_setup', manager }} t={t} onOpenMembers={vi.fn()} onReload={vi.fn()} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('kubecode.members.setup.configRejected (bad model)')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.retrySetup' }))
    expect(await screen.findByText('still broken')).toBeInTheDocument()
    const onOpenMembers = vi.fn()
    rerender(<ManagerSetupNotice api={client} projectId="p1" setup={{ kind: 'missing' }} t={t} onOpenMembers={onOpenMembers} onReload={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('kubecode.members.managerSetup.missing')
    expect(screen.queryByRole('button', { name: 'kubecode.members.retrySetup' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.members.managerSetup.openMembers' }))
    expect(onOpenMembers).toHaveBeenCalledWith(null)
  })
})
