import { describe, expect, it } from 'vitest'

import {
  defaultEnvelopeDraft,
  draftFromLimits,
  limitsFromDraft,
  parseCommand,
} from './executionEnvelope'

const NOW = 1_800_000_000

function draft(overrides: Record<string, string | boolean | number | null> = {}) {
  return { ...defaultEnvelopeDraft(), commands: 'python3 train.py', ...overrides }
}

describe('parseCommand', () => {
  it('splits on whitespace and keeps quoted tokens whole', () => {
    expect(parseCommand('python3 train.py --name "my run" --tag \'a b\'')).toEqual([
      'python3', 'train.py', '--name', 'my run', '--tag', 'a b',
    ])
    expect(parseCommand('   ')).toEqual([])
  })
})

describe('limitsFromDraft', () => {
  it('builds limits in seconds with allowed argv prefixes', () => {
    const result = limitsFromDraft(draft({ commands: 'python3 train.py\n\nbash scripts/eval.sh' }), NOW)
    expect(result).toEqual({
      ok: true,
      limits: {
        max_launches: 5,
        max_concurrent: 1,
        deadline_at: null,
        max_runtime_secs: 1800,
        max_no_progress: 3,
        allowed_commands: [['python3', 'train.py'], ['bash', 'scripts/eval.sh']],
      },
    })
  })

  it('names the first field that is out of range, mirroring the server bounds', () => {
    const field = (overrides: Record<string, string>) => {
      const result = limitsFromDraft(draft(overrides), NOW)
      return result.ok ? null : result.field
    }
    expect(field({ maxLaunches: '0' })).toBe('launches')
    expect(field({ maxLaunches: '51' })).toBe('launches')
    expect(field({ maxConcurrent: '5' })).toBe('concurrent')
    expect(field({ maxRuntimeMinutes: '1441' })).toBe('runtime')
    expect(field({ maxNoProgress: 'x' })).toBe('noProgress')
    expect(field({ deadlineHours: '-1' })).toBe('deadline')
    expect(field({ commands: '  \n ' })).toBe('commands')
    expect(field({})).toBeNull()
  })

  it('turns a deadline in hours into an absolute time', () => {
    const result = limitsFromDraft(draft({ deadlineHours: '2.5' }), NOW)
    expect(result.ok && result.limits.deadline_at).toBe(NOW + 9000)
  })
})

describe('draftFromLimits', () => {
  const limits = {
    max_launches: 4, max_concurrent: 2, deadline_at: NOW + 7200, max_runtime_secs: 1800,
    max_no_progress: 3, allowed_commands: [['python3', 'train.py'], ['sh', '-c', 'echo hi there']],
  }

  it('round-trips and keeps an unedited deadline exactly', () => {
    const existing = draftFromLimits(limits, NOW)
    expect(existing.commands).toBe('python3 train.py\nsh -c "echo hi there"')
    // Saving later must not silently move the deadline.
    const result = limitsFromDraft(existing, NOW + 3600)
    expect(result.ok && result.limits).toEqual(limits)
  })

  it('moves the deadline only when the researcher edits it', () => {
    const edited = { ...draftFromLimits(limits, NOW), deadlineHours: '1', deadlineEdited: true }
    const result = limitsFromDraft(edited, NOW)
    expect(result.ok && result.limits.deadline_at).toBe(NOW + 3600)
    const cleared = { ...edited, deadlineHours: '' }
    expect(limitsFromDraft(cleared, NOW)).toMatchObject({ ok: true, limits: { deadline_at: null } })
  })
})
