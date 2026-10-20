import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { NeedsYouEntry } from '../app/location/needsYou'
import { useNeedsYouAnnouncement } from './useNeedsYouAnnouncement'

const t = createTranslator('en')
const entry = (key: string, title: string, state: NeedsYouEntry['state'] = 'waiting'): NeedsYouEntry => ({
  key,
  title,
  reason: { label: 'Question', tone: 'warn' },
  target: { place: { view: 'board' } },
  group: 'decision',
  state,
})

describe('useNeedsYouAnnouncement', () => {
  it('announces a decision that newly needs the researcher, and one answered that left', () => {
    const view = renderHook(({ entries }) => useNeedsYouAnnouncement(entries, t), { initialProps: { entries: [] as NeedsYouEntry[] } })
    expect(view.result.current).toBe('')
    view.rerender({ entries: [entry('question:d1', 'Which ratios?')] })
    expect(view.result.current).toBe('Which ratios? needs you')
    view.rerender({ entries: [entry('question:d1', 'Which ratios?', 'resolving')] })
    view.rerender({ entries: [] })
    expect(view.result.current).toBe('Resolved: Which ratios?')
  })

  it('says nothing new when the same decisions are read again', () => {
    const first = [entry('question:d1', 'Which ratios?')]
    const view = renderHook(({ entries }) => useNeedsYouAnnouncement(entries, t), { initialProps: { entries: first } })
    view.rerender({ entries: [entry('question:d1', 'Which ratios?')] })
    expect(view.result.current).toBe('')
  })
})
