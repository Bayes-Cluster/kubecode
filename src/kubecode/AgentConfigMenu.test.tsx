import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { AgentControlMenu } from './AgentControlMenu'

const groups = [
  {
    currentValue: 'instant',
    id: 'config:effort',
    name: 'Intelligence',
    options: [
      { id: 'instant', name: 'Instant' },
      { id: 'high', name: 'High' },
    ],
    type: 'select' as const,
  },
  {
    currentValue: 'gpt-5.6',
    id: 'config:model',
    name: 'Model',
    options: [
      { id: 'gpt-5.6', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
    ],
    type: 'select' as const,
  },
]

describe('AgentControlMenu', () => {
  it('keeps mode and every Agent-native option behind one summary button', () => {
    const onChange = vi.fn()
    render(
      <AgentControlMenu
        agent="codex"
        configs={groups.map((group) => ({ ...group, id: group.id.slice('config:'.length), kind: 'config' as const }))}
        mode={{ currentValue: 'plan', id: 'mode', kind: 'mode', name: 'Mode', options: [{ id: 'plan', name: 'Plan' }], type: 'select' }}
        modeDisabled={false}
        onConfigChange={onChange}
        onModeChange={vi.fn()}
        t={createTranslator('en')}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Agent settings' })
    expect(trigger).toHaveTextContent('Plan')
    fireEvent.click(trigger)
    const menu = screen.getByRole('dialog', { name: 'Agent settings' })
    expect(menu).toBeInTheDocument()
    expect(menu.parentElement?.parentElement).toBe(document.body)
    fireEvent.click(screen.getByRole('button', { name: /GPT-5.6 Sol.*Model/i }))
    fireEvent.click(screen.getByRole('button', { name: 'GPT-5.5' }))

    expect(onChange).toHaveBeenCalledWith('model', 'gpt-5.5')
  })

  it('keeps a long OpenCode model catalog inside a scrollable viewport', () => {
    const modelOptions = Array.from({ length: 40 }, (_, index) => ({
      id: `model-${index}`,
      name: `Provider model ${index}`,
    }))
    render(
      <AgentControlMenu
        agent="opencode"
        configs={[
          { ...groups[0], id: 'effort', kind: 'config' as const },
          { ...groups[1], id: 'model', kind: 'config' as const, currentValue: 'model-0', options: modelOptions },
        ]}
        mode={null}
        modeDisabled={false}
        onConfigChange={vi.fn()}
        onModeChange={vi.fn()}
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
