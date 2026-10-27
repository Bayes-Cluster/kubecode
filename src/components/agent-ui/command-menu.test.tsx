import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CommandMenuFeedback, CommandMenuPill, highlightMatch } from './command-menu'

/**
 * ADR 0257 §7: the command-menu presentation tracks cmdk's own selection
 * without re-rendering rows, highlights the query, and settles the run
 * feedback by itself. The keyboard semantics belong to cmdk and are not
 * duplicated here.
 */

/** The presentation settles one frame in; jsdom's rAF is a real timer. */
const tick = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30))
})

describe('highlightMatch', () => {
  it('marks the first folded match and leaves non-matches alone', () => {
    const { container } = render(highlightMatch('Préfets list', 'pref'))
    expect(container.querySelector('mark')?.textContent).toBe('Préf')
    expect(container.textContent).toBe('Préfets list')

    const { container: plain } = render(highlightMatch('nothing here', 'zzz'))
    expect(plain.querySelector('mark')).toBeNull()

    // A query longer than a decomposed text cannot mark; render it plain.
    const { container: safe } = render(highlightMatch('état', 'etat x'))
    expect(safe.querySelector('mark')).toBeNull()
  })
})

describe('CommandMenuPill', () => {
  it('follows the row cmdk selected and stops at nothing when none is', async () => {
    const { container } = render(
      <div className="agx-cmd__list">
        <CommandMenuPill />
        <button type="button" data-selected="true" className="agx-cmd__item">
          first
        </button>
        <button type="button" className="agx-cmd__item">
          second
        </button>
      </div>,
    )
    const list = container.querySelector('.agx-cmd__list') as HTMLElement
    const pill = container.querySelector('.agx-cmd__pill') as HTMLElement
    await tick()
    expect(pill.dataset.lit).toBe('')

    // cmdk flips the attribute; the pill slides without a re-render of rows.
    ;(list.querySelector('[data-selected]') as HTMLElement).removeAttribute('data-selected')
    ;(list.querySelectorAll('.agx-cmd__item')[1] as HTMLElement).setAttribute('data-selected', 'true')
    await tick()
    expect(pill.dataset.lit).toBe('')

    // No selection: the pill goes dark.
    ;(list.querySelector('[data-selected]') as HTMLElement).removeAttribute('data-selected')
    await tick()
    expect(pill.dataset.lit).toBeUndefined()
  })
})

describe('CommandMenuFeedback', () => {
  it('shows the idle hint, the ran label once, and settles back by itself', async () => {
    const { rerender } = render(<CommandMenuFeedback hint="hints" ranLabel={null} feedbackMs={40} />)
    expect(screen.getByText('hints')).toBeInTheDocument()

    rerender(<CommandMenuFeedback hint="hints" ranLabel="Open settings" feedbackMs={40} />)
    await tick()
    expect(screen.getByText('Open settings')).toBeInTheDocument()

    // The window passes without the caller changing anything: the hints return.
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(screen.getByText('hints')).toBeInTheDocument()
  })
})

describe('the pill under a cmdk-style selection move', () => {
  it('slides when the selection moves through React state, as cmdk does', async () => {
    const rows = ['one', 'two']
    const { rerender, container } = render(
      <div className="agx-cmd__list">
        <CommandMenuPill />
        {rows.map((row, index) => (
          <button key={row} type="button" data-selected={index === 0 || undefined} className="agx-cmd__item">
            {row}
          </button>
        ))}
      </div>,
    )
    await tick()
    expect(container.querySelector('.agx-cmd__pill')).toHaveAttribute('data-lit')

    // cmdk moves the selection with React state; the pill follows without
    // the rows knowing about it.
    rerender(
      <div className="agx-cmd__list">
        <CommandMenuPill />
        {rows.map((row, index) => (
          <button key={row} type="button" data-selected={index === 1 || undefined} className="agx-cmd__item">
            {row}
          </button>
        ))}
      </div>,
    )
    await tick()
    expect(container.querySelector('.agx-cmd__pill')).toHaveAttribute('data-lit')
  })
})
