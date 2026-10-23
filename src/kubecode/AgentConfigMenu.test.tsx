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

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Agent settings' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return screen.getByRole('menu', { name: 'Agent settings' })
}

function openSub(name: RegExp) {
  const item = screen.getByRole('menuitem', { name })
  fireEvent.keyDown(item, { key: 'ArrowRight' })
}

describe('AgentControlMenu', () => {
  it('keeps mode and every Agent-native option behind one official dropdown menu', () => {
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

    expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveTextContent('Plan')
    const menu = openMenu()
    expect(menu).toHaveAttribute('data-slot', 'dropdown-menu-content')
    openSub(/Model/)
    const model = screen.getByRole('menuitemradio', { name: 'GPT-5.6 Sol' })
    expect(model).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT-5.5' }))

    expect(onChange).toHaveBeenCalledWith('model', 'gpt-5.5')
  })

  it('shows a locked mode as a disabled item with its reason and keeps boolean options as checkbox items', () => {
    const onChange = vi.fn()
    render(
      <AgentControlMenu
        agent="claude"
        configs={[{ currentValue: false, id: 'thinking', kind: 'config', name: 'Thinking', type: 'boolean' }]}
        mode={{ currentValue: 'plan', id: 'mode', kind: 'mode', name: 'Mode', options: [{ id: 'plan', name: 'Plan' }], type: 'select' }}
        modeDisabled
        modeDisabledReason="Locked by the team"
        onConfigChange={onChange}
        onModeChange={vi.fn()}
        t={createTranslator('en')}
      />,
    )

    openMenu()
    const mode = screen.getByRole('menuitem', { name: /Plan/ })
    expect(mode).toHaveAttribute('data-disabled')
    expect(mode).toHaveAttribute('title', 'Locked by the team')
    const thinking = screen.getByRole('menuitemcheckbox', { name: 'Thinking' })
    expect(thinking).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(thinking)
    expect(onChange).toHaveBeenCalledWith('thinking', true)
  })

  it('keeps a long OpenCode model catalog inside a scrollable sub menu', () => {
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

    openMenu()
    openSub(/Provider model 0/)

    const sub = document.querySelector('[data-slot="dropdown-menu-sub-content"]')
    expect(sub).toHaveTextContent('Model')
    expect(sub).toHaveClass('overflow-y-auto')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(40)
  })
})
