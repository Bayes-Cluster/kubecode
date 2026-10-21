import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { SubagentEntry } from './conversationReducer'
import { SubagentBubble } from './SubagentBubble'

function entry(overrides: Partial<SubagentEntry> = {}): SubagentEntry {
  return {
    subSessionId: 'sub-1',
    name: 'Explorer',
    prompt: 'Map the repository',
    status: 'running',
    conversationId: null,
    events: [{ seq: 1, kind: 'agent_message', payload: { text: 'Reading src/' } }],
    ...overrides,
  } as SubagentEntry
}

describe('SubagentBubble', () => {
  it('stays open while the subagent runs and names its state in words', () => {
    render(<SubagentBubble entry={entry()} t={createTranslator('en')} />)
    const toggle = screen.getByTestId('subagent-bubble-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('subagent-bubble-status')).toHaveTextContent('running')
    expect(screen.getByTestId('subagent-bubble-event')).toHaveTextContent('Reading src/')
  })

  it('collapses once done unless the reader opens it, in the reader\'s language', () => {
    render(<SubagentBubble entry={entry({ status: 'completed' })} t={createTranslator('de-DE')} />)
    const toggle = screen.getByTestId('subagent-bubble-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: 'Aktivität des Subagenten' })).toHaveTextContent('Reading src/')
  })
})
