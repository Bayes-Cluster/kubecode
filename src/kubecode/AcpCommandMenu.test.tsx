import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AcpCommandMenu } from './AcpCommandMenu'
import type { AcpCommand } from './acpCommands'

const commands: AcpCommand[] = [
  { ambiguous: false, description: 'Compact the context', input: { kind: 'none' }, name: 'compact', providerIndex: 0 },
  { ambiguous: false, description: 'Review a change', input: { hint: 'path', kind: 'text' }, name: 'review', providerIndex: 1 },
  { ambiguous: false, description: 'Needs a picker', input: { kind: 'unsupported' }, name: 'pick', providerIndex: 2 },
]

describe('AcpCommandMenu', () => {
  it('lists Agent commands on the official Command list and follows the composer selection', () => {
    const onHover = vi.fn()
    const onSelect = vi.fn()
    render(
      <AcpCommandMenu
        commands={commands}
        label="Commands"
        onHover={onHover}
        onSelect={onSelect}
        selectedIndex={1}
        unavailableLabel="Unavailable"
      />,
    )

    const list = screen.getByRole('listbox', { name: 'Commands' })
    expect(list).toHaveAttribute('data-slot', 'command-list')
    const review = screen.getByRole('option', { name: /\/review/ })
    expect(review).toHaveAttribute('aria-selected', 'true')
    expect(review).toHaveTextContent('path')
    fireEvent.click(review)
    expect(onSelect).toHaveBeenCalledWith(commands[1])
  })

  it('marks an unsupported command unavailable and never selects it', () => {
    const onSelect = vi.fn()
    render(
      <AcpCommandMenu
        commands={commands}
        label="Commands"
        onHover={vi.fn()}
        onSelect={onSelect}
        selectedIndex={0}
        unavailableLabel="Unavailable"
      />,
    )

    const pick = screen.getByRole('option', { name: /\/pick/ })
    expect(pick).toHaveAttribute('aria-disabled', 'true')
    expect(pick).toHaveTextContent('Unavailable')
    fireEvent.click(pick)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
