import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SourceList, type SourceItem } from './source-list'

/**
 * ADR 0257 §7: chips select (pointer and keyboard), the fold opens without
 * closing a previous panel abruptly (the crossfade keeps the outgoing node),
 * states stay visible, and a second click clears the selection.
 */

const SOURCES: SourceItem[] = [
  { id: 'a', kindLabel: 'File', title: 'results.csv', versionLabel: 'v3' },
  { id: 'b', kindLabel: 'Evidence', title: 'baseline-run', state: { tone: 'warn', label: 'Changed since cited' }, snippet: 'loss=0.42 on the held-out split' },
]

function renderList(overrides: Partial<Parameters<typeof SourceList>[0]> = {}) {
  const onSelect = vi.fn()
  const onOpen = vi.fn()
  const view = render(
    <SourceList
      aria-label="References"
      closeLabel="Close"
      openLabel="Open"
      previewLabel="Preview"
      sources={SOURCES}
      onSelect={onSelect}
      onOpen={onOpen}
      {...overrides}
    />,
  )
  return { ...view, onSelect, onOpen }
}

describe('SourceList', () => {
  it('renders kind, number, version and state on each chip', () => {
    const { container } = renderList()
    expect(screen.getByRole('list', { name: 'References' })).toBeInTheDocument()
    expect(screen.getByText('File')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    expect(container.querySelector('[data-tone="warn"]')).not.toBeNull()
    expect(screen.getByText('Changed since cited')).toBeInTheDocument()
  })

  it('selects on click, opens the fold with the preview, and clears on a second click', async () => {
    const { container, onSelect } = renderList()
    fireEvent.click(screen.getByRole('button', { name: /File/ }))
    expect(onSelect).toHaveBeenCalledWith('a')
    expect(container.querySelector('.agx-src')).toHaveAttribute('data-open')
    await waitFor(() => expect(screen.getByText('results.csv', { selector: '.agx-src__preview-title' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /File/ }))
    expect(onSelect).toHaveBeenLastCalledWith(null)
    expect(container.querySelector('.agx-src')).not.toHaveAttribute('data-open')
  })

  it('crossfades the preview when another chip is selected', async () => {
    const { container } = renderList()
    fireEvent.click(screen.getByRole('button', { name: /File/ }))
    await waitFor(() => expect(screen.getByText('results.csv', { selector: '.agx-src__preview-title' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Evidence/ }))
    expect(container.querySelector('.agx-blur__layer--out')).not.toBeNull()
    await waitFor(() => expect(screen.getByText('baseline-run', { selector: '.agx-src__preview-title' })).toBeInTheDocument())
  })

  it('follows a controlled selection', () => {
    const { rerender } = renderList({ selectedId: null })
    expect(screen.getByRole('button', { name: /File/ })).toHaveAttribute('aria-expanded', 'false')
    rerender(
      <SourceList
        aria-label="References"
        closeLabel="Close"
        openLabel="Open"
        previewLabel="Preview"
        selectedId="b"
        sources={SOURCES}
      />,
    )
    expect(screen.getByRole('button', { name: /Evidence/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Changed since cited', { selector: '.agx-src__state' })).toBeInTheDocument()
  })

  it('opens the selected source and closes the preview from its affordances', async () => {
    const { onOpen } = renderList()
    fireEvent.click(screen.getByRole('button', { name: /Evidence/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument())
  })
})
