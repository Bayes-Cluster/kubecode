import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { memberDirectory } from '../members/memberDirectory'
import { analyst, general, member } from '../members/memberFixtures'
import { mentionOptions } from './mentionOptions'

const t = createTranslator('en')

describe('mentionOptions', () => {
  it('offers every live member by member id with their identity, and says who cannot receive yet', () => {
    const unready = member({ id: 'u', name: 'Unready', handle: 'unready', state: 'setup_required', public_conversation_id: null })
    const removed = member({ id: 'old', name: 'Old', handle: 'old', state: 'removed' })
    const options = mentionOptions(memberDirectory({ members: [analyst, unready, removed, general], general_id: 'g' }, 'ready'), t)
    expect(options).toEqual([
      { id: 'g', handle: 'general', label: 'General', identity: { role: 'manager', roleLabel: 'Project manager' } },
      { id: 'a', handle: 'analyst', label: 'Analyst', identity: { role: 'specialist', roleLabel: 'Specialist · Analysis' } },
      {
        id: 'u', handle: 'unready', label: 'Unready',
        identity: { role: 'specialist', roleLabel: 'Specialist · Analysis', unavailable: "Can't receive messages yet" },
      },
    ])
  })
})
