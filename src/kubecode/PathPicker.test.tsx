import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PathPicker } from './PathPicker'

describe('PathPicker', () => {
  it('moves through flat path rows with the keyboard and selects with Enter', () => {
    const onQueryChange = vi.fn()
    const onSelect = vi.fn()
    render(
      <PathPicker
        ariaLabel="Search files"
        emptyMessage="No matching files"
        onQueryChange={onQueryChange}
        onSelect={onSelect}
        placeholder="Search files"
        query=""
        rows={[
          { id: 'src', kind: 'directory', label: 'src', path: 'src' },
          { id: 'readme', kind: 'file', label: 'README.md', path: 'README.md' },
        ]}
      />,
    )

    const input = screen.getByRole('combobox', { name: 'Search files' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'README.md' }))
  })

  it('skips disabled rows and exposes the active option', () => {
    const onSelect = vi.fn()
    render(
      <PathPicker
        ariaLabel="Choose path"
        emptyMessage="No paths"
        onQueryChange={vi.fn()}
        onSelect={onSelect}
        placeholder="Choose path"
        query="/srv/demo"
        rows={[
          {
            disabled: true,
            id: 'create',
            kind: 'action',
            label: 'Create /srv/demo',
            path: '/srv/demo',
          },
          { id: 'demo', kind: 'directory', label: 'demo', path: '/srv/demo' },
        ]}
      />,
    )

    const input = screen.getByRole('combobox', { name: 'Choose path' })
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-demo$/)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'demo' }))
  })
})
