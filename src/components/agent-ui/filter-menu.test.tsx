import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AgxFilterChip, AgxFilterGroup, AgxFilterMenu, AgxFilterOption } from './filter-menu'

/**
 * ADR 0257 §7: the menu presents; the adapter owns the options. Groups fold
 * (aria-expanded drives it), the check is said by aria-checked, the clear
 * is a real control the caller arms, and a disabled option answers nothing.
 */

function Menu() {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState(false)
  return (
    <AgxFilterMenu
      chips={<AgxFilterChip>Width sweep</AgxFilterChip>}
      clearDisabled={false}
      clearLabel="Clear"
      hints={<><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> pick</span></>}
      title="Filters"
      onClear={() => setPicked(false)}
    >
      <AgxFilterGroup count={2} label="Source" onOpenChange={setOpen} open={open} picked={picked ? 'Workspace' : undefined}>
        <AgxFilterOption checked={picked} label="Workspace" onToggle={() => setPicked((v) => !v)} />
        <AgxFilterOption checked={false} disabled label="Legacy" onToggle={vi.fn()} />
      </AgxFilterGroup>
    </AgxFilterMenu>
  )
}

describe('AgxFilterMenu', () => {
  it('names itself, arms the clear, shows the chips and the hints', () => {
    render(<Menu />)
    expect(screen.getByText('Filters')).toHaveClass('agx-filt__title')
    expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled()
    expect(screen.getByText('Width sweep')).toHaveClass('agx-filt__chip')
    expect(screen.getByText('↵').closest('footer')).toHaveClass('agx-filt__hints')
  })

  it('folds a group by its state and says picked on the head', async () => {
    render(<Menu />)
    const head = screen.getByRole('button', { name: /Source/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    // The fold is the presentation; in jsdom the options answer either way.
    const workspace = screen.getByRole('checkbox', { name: 'Workspace' })
    expect(workspace).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(workspace)
    expect(workspace).toHaveAttribute('aria-checked', 'true')
    // The group head sums up what is picked.
    expect(document.querySelector('.agx-filt__group-picked')).toHaveTextContent('Workspace')
  })

  it('leaves a disabled option unanswered', () => {
    const onToggle = vi.fn()
    render(<AgxFilterOption checked={false} disabled label="Legacy" onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Legacy' }))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('omits the clear and the chips the host does not arm', () => {
    render(<AgxFilterMenu title="Filters"><AgxFilterGroup label="Source" onOpenChange={vi.fn()} open={false} /></AgxFilterMenu>)
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(document.querySelector('.agx-filt__chips')).toBeNull()
    expect(document.querySelector('.agx-filt__hints')).toBeNull()
  })
})
