import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  AgxBoard,
  AgxBoardCardBody,
  AgxBoardCard,
  AgxBoardChips,
  AgxBoardChip,
  AgxBoardColumn,
  AgxBoardColumns,
  AgxBoardDrop,
} from './board'

/**
 * ADR 0257 §7: the board presents; the adapter owns legality. The column
 * says what landed on it (drop target), the card shell says what is being
 * dragged, and an empty column says so only when the adapter gives it words.
 */

describe('AgxBoardColumn', () => {
  it('names its lane, counts from the projection, and tints when a move would land', () => {
    const onDragOver = vi.fn()
    render(
      <AgxBoardColumns>
        <AgxBoardColumn
          count={3}
          data-testid="lane"
          label="Running"
          onDragOver={onDragOver}
          over
        >
          <AgxBoardCard>
            <AgxBoardCardBody>One</AgxBoardCardBody>
          </AgxBoardCard>
        </AgxBoardColumn>
      </AgxBoardColumns>,
    )
    const lane = screen.getByTestId('lane')
    expect(lane).toHaveAttribute('data-over')
    expect(screen.getByText('Running')).toHaveClass('agx-board__col-title')
    expect(screen.getByText('3')).toHaveClass('agx-board__col-count')
    expect(screen.getByText('One').closest('.agx-board__card')).toBeInTheDocument()
    // The adapter's drag handlers pass straight through.
    fireEvent.dragOver(lane)
    expect(onDragOver).toHaveBeenCalled()
  })

  it('says the lane is empty only when the adapter gives it words and the count is zero', () => {
    render(
      <AgxBoardColumn count={0} emptyLabel="Nothing here" label="Done" />,
    )
    expect(screen.getByText('Nothing here')).toHaveClass('agx-board__empty')
  })

  it('stays quiet for an empty lane the adapter left wordless', () => {
    render(<AgxBoardColumn count={0} label="Done" />)
    expect(document.querySelector('.agx-board__empty')).toBeNull()
  })
})

describe('AgxBoardCard', () => {
  it('marks the dragged card and folds the secondary lines in the compact mode', () => {
    const { rerender } = render(
      <AgxBoardCard data-testid="card">
        <AgxBoardCardBody>
          <span>Title</span>
          <span className="agx-board__card-secondary">Objective</span>
        </AgxBoardCardBody>
      </AgxBoardCard>,
    )
    const card = screen.getByTestId('card')
    expect(card).not.toHaveAttribute('data-dragging')
    expect(card).not.toHaveAttribute('data-compact')
    rerender(
      <AgxBoardCard compact dragging data-testid="card">
        <AgxBoardCardBody>
          <span>Title</span>
          <span className="agx-board__card-secondary">Objective</span>
        </AgxBoardCardBody>
      </AgxBoardCard>,
    )
    expect(card).toHaveAttribute('data-dragging')
    expect(card).toHaveAttribute('data-compact')
  })
})

describe('AgxBoardChip and AgxBoardDrop', () => {
  it('tones a chip and hides the drop indicator from assistive tech', () => {
    render(
      <AgxBoard>
        <AgxBoardChips>
          <AgxBoardChip data-testid="chip" tone="warn">needs input</AgxBoardChip>
        </AgxBoardChips>
        <AgxBoardDrop />
      </AgxBoard>,
    )
    expect(screen.getByTestId('chip')).toHaveAttribute('data-tone', 'warn')
    expect(document.querySelector('.agx-board__drop')).toHaveAttribute('aria-hidden', 'true')
  })
})
