import type { ChannelMessage, Member } from '../api'

/** Test support: a member as the roster reports it. Not used by the app. */
export function member(overrides: Partial<Member> & Pick<Member, 'id' | 'name' | 'handle'>): Member {
  return {
    project_id: 'p1',
    role: 'specialist',
    template: 'analysis',
    spec: { agent_id: 'opencode', config: {}, instructions: '' },
    public_conversation_id: `s-${overrides.id}`,
    dm_conversation_id: null,
    state: 'active',
    setup_error: null,
    setup_code: null,
    revision: 1,
    created_at: '2026-10-18 10:00:00',
    updated_at: '2026-10-18 10:00:00',
    removed_at: null,
    ...overrides,
  }
}

/** The project manager and two specialists, the way most tests meet a Workspace. */
export const general = member({ id: 'g', name: 'General', handle: 'general', role: 'general', template: 'general' })
export const analyst = member({ id: 'a', name: 'Analyst', handle: 'analyst', template: 'analysis' })
export const writer = member({ id: 'w', name: 'Writer', handle: 'writer', template: 'writing' })

/** Test support: a General message. */
export function channelMessage(seq: number, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `m${seq}`, project_id: 'p1', channel_id: 'c1', thread_id: null, seq, kind: 'message',
    author_kind: 'researcher', author_ref: null, body: `message ${seq}`, intent: 'say', mentions: [], references: [],
    client_message_id: null, intent_claimed_by: null, created_at: '2026-10-18 10:00:00',
    task_id: null, reply_to: null, hops: 0, ...overrides,
  }
}
