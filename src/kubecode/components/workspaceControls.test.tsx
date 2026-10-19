import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Composer, type ComposerProps } from '@/components/workspace/Composer'
import { IconButton } from '@/components/workspace/IconButton'
import {
  extractMentions,
  filterMentions,
  insertMention,
  mentionQueryAt,
  type MentionOption,
} from '@/components/workspace/mentions'
import { SendButton, StopButton } from '@/components/workspace/SendButton'
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
    expect(box).toHaveAttribute('aria-activedescendant', expect.stringMatching(/-option-1$/))
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
    const busy = screen.getByRole('button', { name: 'Remove Analyst' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(busy)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders a status with its tone but always with its words', () => {
    render(<StatusBadge tone="warn" title="Needs attention">Needs setup</StatusBadge>)
    const badge = screen.getByText('Needs setup')
    expect(badge).toHaveAttribute('data-tone', 'warn')
    expect(badge).toHaveAttribute('title', 'Needs attention')
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

describe('SendButton and StopButton', () => {
  it('sends only when it can, and waits while a send is in flight', () => {
    const onSend = vi.fn()
    const { rerender } = render(<SendButton canSend label="Send" onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(1)
    rerender(<SendButton canSend={false} label="Send" onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    rerender(<SendButton busy canSend label="Send" onSend={onSend} />)
    const waiting = screen.getByRole('button', { name: 'Send' })
    expect(waiting).toBeDisabled()
    expect(waiting).toHaveAttribute('aria-busy', 'true')
  })

  it('stops the thing it names and nothing else', () => {
    const onStop = vi.fn()
    render(<StopButton label="Stop Analyst" testId="stop" onStop={onStop} />)
    fireEvent.click(screen.getByTestId('stop'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Stop Analyst' })).toHaveAttribute('type', 'button')
  })
})

describe('IconButton sizes', () => {
  it('is compact by default, regular on request, and honours disabled', () => {
    const { rerender } = render(<IconButton icon={<svg />} label="Open" />)
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('data-size', 'sm')
    rerender(<IconButton icon={<svg />} label="Open" size="md" />)
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('data-size', 'md')
    rerender(<IconButton disabled icon={<svg />} label="Open" />)
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled()
  })
})

describe('Composer keyboard details', () => {
  const originalMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('completes with Tab only once there is something to complete, and Shift+Tab never completes', () => {
    render(<Harness />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    fireEvent.change(box, { target: { value: '@', selectionStart: 1 } })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // An empty "@" does not trap Tab.
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(true)
    expect((box as HTMLTextAreaElement).value).toBe('@')
    fireEvent.change(box, { target: { value: '@da', selectionStart: 3 } })
    expect(fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })).toBe(true)
    expect((box as HTMLTextAreaElement).value).toBe('@da')
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false)
    expect((box as HTMLTextAreaElement).value).toBe('@data-analyst ')
  })

  it('moves up and wraps around the list', () => {
    render(<Harness />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    fireEvent.change(box, { target: { value: '@', selectionStart: 1 } })
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('@data-analyst')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('@general')
  })

  it('does not suggest anyone while the box is disabled', () => {
    render(<Harness disabled initial="@g" />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('lets Enter send again after a composition that never ended', () => {
    const onSend = vi.fn()
    render(<Harness initial="draft" onSend={onSend} />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    fireEvent.compositionStart(box)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.blur(box)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('breaks the line on Enter with a touch keyboard, and still sends on the arrow or a chord', () => {
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
    const onSend = vi.fn()
    render(<Harness initial="draft" onSend={onSend} />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('announces a send in flight to assistive technology', () => {
    render(<Harness busy busyLabel="Sending…" initial="draft" />)
    expect(screen.getByRole('status')).toHaveTextContent('Sending…')
  })

  it('sends one draft once even when Enter is pressed twice before the send settles', async () => {
    let finish: () => void = () => {}
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<Harness initial="draft" onSend={onSend} />)
    const box = screen.getByRole('combobox', { name: 'Message' })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(box).toHaveFocus())
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(2)
  })
})
