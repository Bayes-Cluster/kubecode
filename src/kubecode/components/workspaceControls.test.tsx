import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Composer, type ComposerProps } from '@/components/workspace/Composer'
import { IconButton } from '@/components/workspace/IconButton'
import {
  extractMentions,
  filterMentions,
  insertMention,
  mentionQueryAt,
  type MentionOption,
} from '@/components/workspace/mentions'
import { StatusBadge } from '@/components/workspace/StatusBadge'

const members: MentionOption[] = [
  { id: 's-general', handle: 'general', label: 'General' },
  { id: 's-analyst', handle: 'data-analyst', label: 'Data Analyst', detail: 'Analysis' },
]

function Harness(props: Partial<ComposerProps> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <Composer
      label="Message"
      mentions={members}
      placeholder="Write"
      sendLabel="Send"
      value={value}
      onChange={setValue}
      onSend={vi.fn()}
      {...props}
    />
  )
}

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

describe('Composer', () => {
  it('sends on Enter, breaks the line on Shift+Enter, and never sends an empty draft', () => {
    const onSend = vi.fn()
    render(<Harness initial="hello" onSend={onSend} />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('does not send while an input method is composing', () => {
    const onSend = vi.fn()
    render(<Harness initial="こんにちは" onSend={onSend} />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    fireEvent.compositionStart(box)
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.compositionEnd(box)
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('has an empty and a disabled state that cannot send, and waits while a send is in flight', () => {
    const onSend = vi.fn()
    const { rerender } = render(<Harness initial="" onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    rerender(<Harness busy initial="draft" onSend={onSend} />)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAttribute('aria-busy', 'true')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    rerender(<Harness disabled initial="draft" onSend={onSend} />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('keeps sending available while a named task runs, and stop is its own control', () => {
    const onSend = vi.fn()
    const onStop = vi.fn()
    render(<Harness initial="more" stop={{ label: 'Stop Data Analyst', onStop }} onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop Data Analyst' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('suggests members after @, moves with the arrow keys, and inserts on Enter or Tab without sending', async () => {
    const onSend = vi.fn()
    render(<Harness mentionLabel="Members" onSend={onSend} />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    expect(box).toHaveAttribute('aria-expanded', 'false')
    fireEvent.change(box, { target: { value: '@', selectionStart: 1 } })
    const list = await screen.findByRole('listbox', { name: 'Members' })
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(2)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('@data-analyst')
    expect(box).toHaveAttribute('aria-activedescendant', expect.stringContaining('s-analyst'))
    fireEvent.keyDown(box, { key: 'Enter' })
    expect((box as HTMLTextAreaElement).value).toBe('@data-analyst ')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.change(box, { target: { value: '@data-analyst hi @ge', selectionStart: 20 } })
    expect(await screen.findByRole('option')).toHaveTextContent('@general')
    fireEvent.keyDown(box, { key: 'Tab' })
    expect((box as HTMLTextAreaElement).value).toBe('@data-analyst hi @general ')
  })

  it('closes the list on Escape and chooses with the mouse', async () => {
    render(<Harness />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    fireEvent.change(box, { target: { value: '@g', selectionStart: 2 } })
    await screen.findByRole('listbox')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.change(box, { target: { value: '@ge', selectionStart: 3 } })
    fireEvent.mouseDown(await screen.findByRole('option', { name: /general/i }))
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('@general '))
  })

  it('is a plain text box when nobody can be mentioned', () => {
    render(<Harness mentions={[]} />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    expect(box).not.toHaveAttribute('aria-expanded')
    fireEvent.change(box, { target: { value: '@g', selectionStart: 2 } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('IconButton and StatusBadge', () => {
  it('names an icon-only button, runs it, and waits while busy', () => {
    const onClick = vi.fn()
    const { rerender } = render(<IconButton icon={<svg />} label="Remove Analyst" onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Remove Analyst' })
    expect(button).toHaveAttribute('type', 'button')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    rerender(<IconButton busy icon={<svg />} label="Remove Analyst" onClick={onClick} />)
    expect(screen.getByRole('button', { name: 'Remove Analyst' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove Analyst' })).toHaveAttribute('aria-busy', 'true')
  })

  it('renders a status with its tone but always with its words', () => {
    render(<StatusBadge tone="warn" title="Needs attention">Needs setup</StatusBadge>)
    const badge = screen.getByText('Needs setup')
    expect(badge).toHaveAttribute('data-tone', 'warn')
    expect(badge).toHaveAttribute('title', 'Needs attention')
  })
})
