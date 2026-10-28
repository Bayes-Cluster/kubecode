import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgxComposer, AgxComposerChip, AgxComposerField, AgxComposerRail } from './composer'

/**
 * ADR 0257 §7: the card carries the focus state; the field measures its
 * text and presents the measured height (bounded, scrolling past the cap);
 * chips say their label in full. The engine's typing contract is tested by
 * its adapters — here only the presentation's own behaviour.
 */

afterEach(() => {
  document.body.innerHTML = ''
})

describe('AgxComposer', () => {
  it('lights the card while focus is inside it and dims it when focus leaves', () => {
    render(
      <AgxComposer>
        <input aria-label="Draft" />
        <button type="button">Send</button>
      </AgxComposer>,
    )
    const card = screen.getByLabelText('Draft').closest('.agx-comp') as HTMLElement
    expect(card).not.toHaveAttribute('data-focused')
    fireEvent.focus(screen.getByLabelText('Draft'))
    expect(card).toHaveAttribute('data-focused')
    // Moving between parts of the composer keeps the card lit.
    fireEvent.blur(screen.getByLabelText('Draft'))
    fireEvent.focus(screen.getByRole('button', { name: 'Send' }))
    expect(card).toHaveAttribute('data-focused')
    fireEvent.blur(screen.getByRole('button', { name: 'Send' }))
    expect(card).not.toHaveAttribute('data-focused')
  })
})

describe('AgxComposerField', () => {
  it('marks the textarea and presents the measured height, floored at `min`', () => {
    const { rerender } = render(
      <AgxComposerField min={40} value="one">
        <textarea aria-label="Draft" rows={2} value="one" readOnly />
      </AgxComposerField>,
    )
    const area = screen.getByLabelText('Draft') as HTMLTextAreaElement
    expect(area).toHaveAttribute('data-autosize')
    // jsdom lays nothing out: scrollHeight reports 0, so the floor holds.
    expect(area.style.height).toBe('40px')
    expect(area.style.overflowY).toBe('hidden')

    // Growing text is measured and presented, until the cap turns the
    // field into a scroller.
    Object.defineProperty(area, 'scrollHeight', { value: 96, configurable: true })
    rerender(
      <AgxComposerField min={40} max={72} value="one\ntwo\nthree\nfour">
        <textarea aria-label="Draft" rows={2} value="one\ntwo\nthree\nfour" readOnly />
      </AgxComposerField>,
    )
    expect(area.style.height).toBe('72px')
    expect(area.style.overflowY).toBe('auto')
  })

  it('presents the whole measurement when nothing caps it', () => {
    const { rerender } = render(
      <AgxComposerField value="long">
        <textarea aria-label="Draft" readOnly value="long" />
      </AgxComposerField>,
    )
    const area = screen.getByLabelText('Draft') as HTMLTextAreaElement
    Object.defineProperty(area, 'scrollHeight', { value: 96, configurable: true })
    rerender(
      <AgxComposerField value="longer">
        <textarea aria-label="Draft" readOnly value="longer" />
      </AgxComposerField>,
    )
    expect(area.style.height).toBe('96px')
    expect(area.style.overflowY).toBe('hidden')
  })
})

describe('AgxComposerChip', () => {
  it('says its label in full, truncates visibly, and marks the accent', () => {
    render(
      <AgxComposerChip label="results.csv from run 4711">
        <em>results.csv</em>
      </AgxComposerChip>,
    )
    const chip = screen.getByText('results.csv').closest('.agx-comp__chip') as HTMLElement
    expect(chip).toHaveAttribute('data-accent')
    expect(chip.querySelector('.agx-comp__chip-label')).toHaveAttribute(
      'title',
      'results.csv from run 4711',
    )
  })

  it('can opt out of the accent glyph slot', () => {
    render(<AgxComposerChip accent={false} label="note.md" />)
    expect(screen.getByText('note.md').closest('.agx-comp__chip')).not.toHaveAttribute('data-accent')
  })
})

describe('AgxComposerRail', () => {
  it('holds the rail between field and send', () => {
    render(
      <AgxComposerRail>
        <span>Tools</span>
        <span>Send</span>
      </AgxComposerRail>,
    )
    expect(screen.getByText('Tools').parentElement).toHaveClass('agx-comp__rail')
  })
})
