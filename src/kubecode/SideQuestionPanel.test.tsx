import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { SideQuestionPanel } from './SideQuestionPanel'

describe('SideQuestionPanel', () => {
  it('shows pending and completed native side questions without adding chat messages', () => {
    render(<SideQuestionPanel
      items={[
        { id: 'side-1', question: 'What are you doing?', runId: 'run-1', status: 'pending' },
        {
          id: 'side-2',
          question: 'Are tests passing?',
          answer: 'The focused tests pass.',
          runId: 'run-1',
          status: 'completed',
        },
      ]}
      t={createTranslator('en')}
    />)

    expect(screen.getByText('Waiting for Claude')).toBeInTheDocument()
    expect(screen.getByText('The focused tests pass.')).toHaveClass('select-text')
    fireEvent.click(screen.getByRole('button', { name: /Side questions/ }))
    expect(screen.queryByText('The focused tests pass.')).not.toBeInTheDocument()
  })

  it('copies a completed answer', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<SideQuestionPanel
      items={[{
        id: 'side-1',
        question: 'Are tests passing?',
        answer: 'Yes.',
        runId: 'run-1',
        status: 'completed',
      }]}
      t={createTranslator('en')}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    expect(writeText).toHaveBeenCalledWith('Yes.')
  })
})
