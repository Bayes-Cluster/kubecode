import { describe, expect, it } from 'vitest'

import { canReceive, memberDirectory, unavailableReason } from './memberDirectory'
import { analyst, general, member, writer } from './memberFixtures'

const removed = member({ id: 'old', name: 'Old', handle: 'old', state: 'removed', public_conversation_id: null })
const unready = member({ id: 'u', name: 'Unready', handle: 'unready', state: 'setup_required', public_conversation_id: null })

describe('memberDirectory', () => {
  it('knows every member by id, removed ones too, and lists the live ones with the manager first', () => {
    const directory = memberDirectory({ members: [analyst, removed, general, writer], general_id: 'g' }, 'ready')
    expect(directory.status).toBe('ready')
    expect(directory.byId.get('old')).toBe(removed)
    expect(directory.live.map((item) => item.id)).toEqual(['g', 'a', 'w'])
    expect(directory.manager).toBe(general)
  })

  it('maps each current public Session to its member, for messages read without the projection', () => {
    const directory = memberDirectory({ members: [general, analyst, removed], general_id: 'g' }, 'ready')
    expect(directory.byCurrentSession.get('s-a')).toBe('a')
    expect(directory.byCurrentSession.get('s-g')).toBe('g')
    expect(directory.byCurrentSession.size).toBe(2)
  })

  it('is empty while the roster is not read, and has no manager without one', () => {
    const loading = memberDirectory(null, 'loading')
    expect(loading.live).toEqual([])
    expect(loading.manager).toBeNull()
    expect(memberDirectory({ members: [analyst], general_id: null }, 'ready').manager).toBeNull()
  })
})

describe('who can receive a message', () => {
  it('is an active member with a public Session; the others say why not', () => {
    expect(canReceive(analyst)).toBe(true)
    expect(unavailableReason(analyst)).toBeNull()
    expect(canReceive(unready)).toBe(false)
    expect(unavailableReason(unready)).toBe('needs_setup')
    expect(canReceive({ ...analyst, public_conversation_id: null })).toBe(false)
    expect(unavailableReason({ ...analyst, public_conversation_id: null })).toBe('needs_setup')
    expect(canReceive(removed)).toBe(false)
    expect(unavailableReason(removed)).toBe('removed')
  })
})
