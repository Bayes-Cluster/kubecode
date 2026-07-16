import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { AgentConfigMenu } from './AgentConfigMenu'

const groups = [
  {
    currentValue: 'instant',
    id: 'config:effort',
    name: 'Intelligence',
    options: [
      { id: 'instant', name: 'Instant' },
      { id: 'high', name: 'High' },
    ],
  },
  {
    currentValue: 'gpt-5.6',
    id: 'config:model',
    name: 'Model',
    options: [
      { id: 'gpt-5.6', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
    ],
  },
]

describe('AgentConfigMenu', () => {
  it('keeps every Agent-native option behind one summary button', () => {
    const onChange = vi.fn()
    render(
      <AgentConfigMenu
        groups={groups}
        onChange={onChange}
        t={createTranslator('en')}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Agent settings' })
    expect(trigger).toHaveTextContent('Instant')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Agent settings' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /GPT-5.6 Sol.*Model/i }))
    fireEvent.click(screen.getByRole('button', { name: 'GPT-5.5' }))

    expect(onChange).toHaveBeenCalledWith('config:model', 'gpt-5.5')
  })
})
