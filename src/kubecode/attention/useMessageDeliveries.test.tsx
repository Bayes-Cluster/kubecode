import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError, type ChannelMessage, type KubecodeApi, type WorkspaceEvent } from '../api'
import { channelMessage } from '../members/memberFixtures'
import { messageDelivery, routeDelivery } from './attentionFixtures'
import { foldRoutingNotes, useMessageDeliveries } from './useMessageDeliveries'

const mine = (seq: number, extra: Partial<ChannelMessage> = {}) => channelMessage(seq, { id: `msg${seq}`, author_kind: 'researcher', ...extra })
const event = (id: number, kind: string, payload: Record<string, unknown>): WorkspaceEvent => ({
  id, kind, project_id: 'p1', conversation_id: null, run_id: null, payload, created_at: '',
})

function setup(messages: ChannelMessage[], api: Partial<Record<keyof KubecodeApi, unknown>>) {
  const client = api as unknown as KubecodeApi
  return renderHook(
    ({ events }: { events: WorkspaceEvent[] }) => useMessageDeliveries(client, 'p1', 'c1', messages, events, 'live'),
    { initialProps: { events: [] as WorkspaceEvent[] } },
  )
}

describe('useMessageDeliveries', () => {
  it('reads the delivery of the researcher\'s own messages only, and again when a route of one changes', async () => {
    const messageDeliveries = vi.fn().mockResolvedValue([messageDelivery({ message_id: 'msg1' })])
    const view = setup([mine(1), channelMessage(2, { id: 'agent2', author_kind: 'agent' })], { messageDeliveries })
    await waitFor(() => expect(view.result.current.deliveries.get('msg1')?.state).toBe('delivered'))
    expect(messageDeliveries).toHaveBeenCalledWith('p1', ['msg1'])
    view.rerender({ events: [event(5, 'orchestration_updated', { message_id: 'other' })] })
    expect(messageDeliveries).toHaveBeenCalledTimes(1)
    view.rerender({ events: [event(6, 'orchestration_updated', { message_id: 'msg1' })] })
    await waitFor(() => expect(messageDeliveries).toHaveBeenCalledTimes(2))
  })

  it('retries a route once while asked, and says why a retry was refused', async () => {
    const failed = messageDelivery({ message_id: 'msg1', state: 'failed', routes: [routeDelivery({ route_id: 'rt', state: 'failed', retryable: true })] })
    const sending = messageDelivery({ message_id: 'msg1', state: 'sending', routes: [routeDelivery({ route_id: 'rt', state: 'sending' })] })
    const messageDeliveries = vi.fn().mockResolvedValueOnce([failed]).mockResolvedValue([sending])
    const retryRoute = vi.fn()
      .mockResolvedValueOnce({ route: { id: 'rt', state: 'pending' }, retried: true, delivery: sending })
      .mockRejectedValueOnce(new ApiError('route_target_gone', 'gone', 409))
    const view = setup([mine(1)], { messageDeliveries, retryRoute })
    await waitFor(() => expect(view.result.current.deliveries.get('msg1')?.state).toBe('failed'))
    act(() => {
      view.result.current.actions.retry('rt', 'msg1')
      view.result.current.actions.retry('rt', 'msg1')
    })
    await waitFor(() => expect(view.result.current.deliveries.get('msg1')?.state).toBe('sending'))
    expect(retryRoute).toHaveBeenCalledTimes(1)
    await act(async () => view.result.current.actions.retry('rt', 'msg1'))
    await waitFor(() => expect(view.result.current.actions.refusals.get('rt')).toBe('gone'))
  })

  it('reroutes a message that reached nobody', async () => {
    const saved = messageDelivery({ message_id: 'msg1', state: 'saved', routes: [] })
    const messageDeliveries = vi.fn()
      .mockResolvedValueOnce([messageDelivery({ message_id: 'msg1', state: 'denied', routes: [], denial: { code: 'manager_unavailable', reroutable: true, note_id: null } })])
      .mockResolvedValue([saved])
    const rerouteMessage = vi.fn().mockResolvedValue(saved)
    const view = setup([mine(1)], { messageDeliveries, rerouteMessage })
    await waitFor(() => expect(view.result.current.deliveries.get('msg1')?.state).toBe('denied'))
    await act(async () => view.result.current.actions.reroute('msg1'))
    expect(rerouteMessage).toHaveBeenCalledWith('p1', 'c1', 'msg1')
    await waitFor(() => expect(view.result.current.deliveries.get('msg1')?.state).toBe('saved'))
  })
})

describe('foldRoutingNotes', () => {
  it('folds a routing note into the message it is about once that message\'s delivery is loaded', () => {
    const note = channelMessage(3, { id: 'n1', author_kind: 'system', body: 'not delivered', client_message_id: 'route-failed:rt' })
    const stray = channelMessage(4, { id: 'n2', author_kind: 'system', body: 'about an older message', client_message_id: 'route-failed:old' })
    const deliveries = new Map([['msg1', messageDelivery({ message_id: 'msg1', routes: [routeDelivery({ note_ids: ['n1'] })] })]])
    const { folded, messages } = foldRoutingNotes([mine(1), note, stray], deliveries)
    expect(messages.map((message) => message.id)).toEqual(['msg1', 'n2'])
    expect(folded.get('msg1')).toEqual(['not delivered'])
  })
})
