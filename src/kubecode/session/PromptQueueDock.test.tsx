import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { PromptQueueDock } from './PromptQueueDock'
import type { PromptQueueItem } from '../api'

const t = createTranslator('en')

function item(overrides: Partial<PromptQueueItem> = {}): PromptQueueItem {
  return {
    id: 'item-1',
    conversation_id: 'conversation-1',
    project_id: 'project-1',
    content: 'First queued prompt',
    status: 'pending',
    position: 1,
    internal: false,
    created_at: 'now',
    ...overrides,
  }
}

function renderDock(
  items: PromptQueueItem[],
  onEdit = vi.fn(),
  onRemove = vi.fn(),
  onSendNow = vi.fn(),
) {
  return render(
    <PromptQueueDock
      items={items}
      onEdit={onEdit}
      onRemove={onRemove}
      onSendNow={onSendNow}
      t={t}
    />,
  )
}

describe('PromptQueueDock', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = renderDock([])
    expect(container).toBeEmptyDOMElement()
  })

  it('renders every queued item in order with collapsed text', () => {
    renderDock([
      item({ id: 'a', content: 'First', position: 1 }),
      item({ id: 'b', content: 'Second', position: 2 }),
    ])
    const rows = screen.getAllByTestId('prompt-queue-row')
    expect(rows).toHaveLength(2)
    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.getByText('Queued prompts (2)')).toBeInTheDocument()
  })

  it('edits in place and commits the new content', () => {
    const onEdit = vi.fn()
    renderDock([item({ id: 'a', content: 'Before' })], onEdit)
    fireEvent.click(screen.getByTestId('prompt-queue-edit'))
    const input = screen.getByTestId('prompt-queue-input')
    fireEvent.change(input, { target: { value: 'After' } })
    fireEvent.click(screen.getByTestId('prompt-queue-save'))
    expect(onEdit).toHaveBeenCalledWith('a', 'After')
  })

  it('removes an item', () => {
    const onRemove = vi.fn()
    renderDock([item({ id: 'a' })], vi.fn(), onRemove)
    fireEvent.click(screen.getByTestId('prompt-queue-remove'))
    expect(onRemove).toHaveBeenCalledWith('a')
  })

  it('sends a queued item now', () => {
    const onSendNow = vi.fn()
    renderDock([item({ id: 'a' })], vi.fn(), vi.fn(), onSendNow)
    fireEvent.click(screen.getByTestId('prompt-queue-send-now'))
    expect(onSendNow).toHaveBeenCalledWith('a')
  })

  it('does not commit an empty edit and supports cancelling the editor', () => {
    const onEdit = vi.fn()
    renderDock([item({ id: 'a', content: 'Keep me' })], onEdit)
    fireEvent.click(screen.getByTestId('prompt-queue-edit'))
    fireEvent.change(screen.getByTestId('prompt-queue-input'), { target: { value: '   ' } })
    expect(screen.getByTestId('prompt-queue-save')).toBeDisabled()
    fireEvent.click(screen.getByTestId('prompt-queue-cancel'))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('Keep me')).toBeInTheDocument()
  })

  it('swaps from empty to non-empty without stale state', () => {
    const { rerender } = renderDock([])
    expect(screen.queryByTestId('prompt-queue')).toBeNull()
    rerender(<PromptQueueDock items={[item()]} onEdit={vi.fn()} onRemove={vi.fn()} t={t} />)
    expect(screen.getByTestId('prompt-queue')).toBeInTheDocument()
  })
})
