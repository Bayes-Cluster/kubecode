import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { IconButton } from '@/components/workspace/IconButton'
import {
  extractMentions,
  filterMentions,
  insertMention,
  mentionQueryAt,
  type MentionOption,
} from '@/components/workspace/mentions'
import { statusToneVariant } from '@/kubecode/statusTone'

const members: MentionOption[] = [
  { id: 's-general', handle: 'general', label: 'General' },
  { id: 's-analyst', handle: 'data-analyst', label: 'Data Analyst', detail: 'Analysis' },
]

describe('mention helpers', () => {
  it('finds the @query before the caret only at a word start', () => {
    expect(mentionQueryAt('hi @da', 6)).toEqual({ start: 3, query: 'da' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('mail me@da', 10)).toBeNull()
    expect(mentionQueryAt('hi @da there', 12)).toBeNull()
    expect(mentionQueryAt('hi @da there', 6)).toEqual({ start: 3, query: 'da' })
  })

  it('filters by handle prefix or label, inserts a handle, and extracts whole-token mentions', () => {
    expect(filterMentions(members, 'da').map((m) => m.id)).toEqual(['s-analyst'])
    expect(filterMentions(members, 'anal').map((m) => m.id)).toEqual(['s-analyst'])
    expect(insertMention('hi @da there', 3, 6, 'data-analyst')).toEqual({
      text: 'hi @data-analyst  there',
      caret: 17,
    })
    expect(extractMentions('@general please ask @data-analyst', members).map((m) => m.id))
      .toEqual(['s-general', 's-analyst'])
    expect(extractMentions('email@general.example and @generalist', members)).toEqual([])
    expect(extractMentions('@GENERAL hello', members).map((m) => m.id)).toEqual(['s-general'])
  })
})

describe('IconButton and status tones', () => {
  it('names an icon-only button, runs it, and waits while busy', () => {
    const onClick = vi.fn()
    const { rerender } = render(<IconButton icon={<svg />} label="Remove Analyst" onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Remove Analyst' })
    expect(button).toHaveAttribute('type', 'button')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    rerender(<IconButton busy icon={<svg />} label="Remove Analyst" onClick={onClick} />)
    const busy = screen.getByRole('button', { name: 'Remove Analyst' })
    // Busy is not disabled: it keeps keyboard focus (ADR 0227).
    expect(busy).not.toBeDisabled()
    busy.focus()
    expect(busy).toHaveFocus()
    expect(busy.querySelector('.animate-spin')).not.toBeNull()
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(busy)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ok', 'success'],
    ['info', 'info'],
    ['warn', 'warning'],
    ['danger', 'destructive'],
    ['muted', 'secondary'],
  ] as const)('maps the %s tone onto the official %s Badge variant (ADR 0256)', (tone, variant) => {
    expect(statusToneVariant(tone)).toBe(variant)
  })

  it('reads a status as muted when no tone is given', () => {
    expect(statusToneVariant()).toBe('secondary')
  })
})

describe('filtering and ranking', () => {
  it('ranks the exact handle, then handle prefixes, then labels, and keeps the caller order on ties', () => {
    const options: MentionOption[] = [
      { id: 'a', handle: 'zeta', label: 'Analyst of data' },
      { id: 'b', handle: 'data', label: 'Data' },
      { id: 'c', handle: 'database', label: 'Database' },
      { id: 'd', handle: 'dataset', label: 'Dataset' },
    ]
    expect(filterMentions(options, 'data').map((m) => m.id)).toEqual(['b', 'c', 'd', 'a'])
    expect(filterMentions(options, '').map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterMentions(options, 'nobody')).toEqual([])
    expect(filterMentions(options, 'data', 2)).toHaveLength(2)
  })
})

describe('IconButton sizes', () => {
  it('is compact by default, regular on request, and honours disabled', () => {
    const { rerender } = render(<IconButton icon={<svg />} label="Open" />)
    // ADR 0256: the official Button's icon sizes, nothing of its own.
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('data-size', 'icon-xs')
    rerender(<IconButton icon={<svg />} label="Open" size="md" />)
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('data-size', 'icon-sm')
    rerender(<IconButton disabled icon={<svg />} label="Open" />)
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled()
  })
})
