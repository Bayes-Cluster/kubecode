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

  it('keeps a long OpenCode model catalog inside a scrollable viewport', () => {
    const modelOptions = Array.from({ length: 40 }, (_, index) => ({
      id: `model-${index}`,
      name: `Provider model ${index}`,
    }))
    render(
      <AgentConfigMenu
        groups={[
          groups[0],
          { ...groups[1], currentValue: 'model-0', options: modelOptions },
        ]}
        onChange={vi.fn()}
        t={createTranslator('en')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.click(screen.getByRole('button', { name: /Provider model 0.*Model/i }))

    expect(screen.getByRole('menu', { name: 'Model' })).toHaveClass(
      'max-h-[min(520px,calc(100vh-80px))]',
      'overflow-y-auto',
    )
  })
})
