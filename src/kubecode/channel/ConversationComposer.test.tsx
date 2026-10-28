import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MentionOption } from '@/components/workspace/mentions'

import { ConversationComposer, type ConversationComposerProps } from './ConversationComposer'

const members: MentionOption[] = [
  { id: 's-general', handle: 'general', label: 'General' },
  { id: 's-analyst', handle: 'data-analyst', label: 'Data Analyst', detail: 'Analysis' },
]

function Harness(props: Partial<ConversationComposerProps> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <ConversationComposer
      label="Message"
      mentionLabel="Members"
      mentions={members}
      placeholder="Write"
      attachLabel="Anhängen"
      sendLabel="Send"
      value={value}
      onChange={setValue}
      onSend={vi.fn()}
      {...props}
    />
  )
}

const box = () => screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement

describe('ConversationComposer (official Prompt Input, ADR 0242)', () => {
  it('names the Prompt Input file input from the caller, not in English (ADR 0246)', () => {
    render(<Harness />)
    const upload = document.querySelector('input[type="file"]')
    expect(upload).toHaveAttribute('aria-label', 'Anhängen')
    expect(upload).toHaveAttribute('title', 'Anhängen')
  })

  const originalMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('is the official Prompt Input: a form around the text box, its tools and the send button', () => {
    render(<Harness initial="hello" tools={<button type="button">Tool</button>} />)
    const form = box().closest('form')
    // The official Prompt Input card, not a restyled one (#257).
    expect(form?.querySelector('[data-slot="input-group"]')).not.toBeNull()
    expect(form?.querySelector('[data-slot="input-group"]')).toContainElement(box())
    expect(screen.getByRole('button', { name: 'Tool' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'button')
  })

  it('sends on Enter or the send button, breaks the line on Shift+Enter, and never sends an empty draft', () => {
    const onSend = vi.fn()
    const { rerender } = render(<Harness initial="hello" onSend={onSend} />)
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(2)
    rerender(<Harness initial="" key="empty" onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('never submits the form by itself, so the text box is not reset under the draft', () => {
    const onSend = vi.fn()
    render(<Harness initial="hello" onSend={onSend} />)
    const event = fireEvent.keyDown(box(), { key: 'Enter' })
    expect(event).toBe(false)
    expect(box()).toHaveValue('hello')
  })

  it('does not send while an input method is composing, nor on the late Enter that ends it', () => {
    const onSend = vi.fn()
    render(<Harness initial="こんにちは" onSend={onSend} />)
    fireEvent.compositionStart(box())
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.compositionEnd(box())
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('lets Enter send again after a composition that never ended', () => {
    const onSend = vi.fn()
    render(<Harness initial="draft" onSend={onSend} />)
    fireEvent.compositionStart(box())
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.blur(box())
    fireEvent.keyDown(box(), { key: 'Enter' })
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
    box().setSelectionRange(5, 5)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box()).toHaveValue('draft\n')
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('keeps sending available while a named turn runs, and Stop is its own control', () => {
    const onSend = vi.fn()
    const onStop = vi.fn()
    render(<Harness initial="more" stop={{ label: 'Stop Data Analyst', shortLabel: 'Stop', onStop }} onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop Data Analyst' }))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('suggests members after @ in the command list, moves with the arrows, and inserts on Enter or Tab without sending', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    box().focus()
    expect(box()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.change(box(), { target: { value: '@', selectionStart: 1 } })
    const list = await screen.findByRole('listbox', { name: 'Members' })
    expect(list).toHaveAttribute('cmdk-list')
    expect(box()).toHaveAttribute('aria-expanded', 'true')
    expect(box()).toHaveAttribute('aria-controls', list.id)
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const selected = await screen.findByRole('option', { selected: true, name: /data-analyst/ })
    await waitFor(() => expect(box()).toHaveAttribute('aria-activedescendant', selected.id))
    // Focus never leaves the text box while choosing.
    expect(box()).toHaveFocus()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box()).toHaveValue('@data-analyst ')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.change(box(), { target: { value: '@data-analyst hi @ge', selectionStart: 20 } })
    expect(await screen.findByRole('option')).toHaveTextContent('@general')
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(box()).toHaveValue('@data-analyst hi @general ')
  })

  it('completes with Tab only once there is something to complete, and wraps around with the arrows', () => {
    render(<Harness />)
    fireEvent.change(box(), { target: { value: '@', selectionStart: 1 } })
    // An empty "@" does not trap Tab.
    expect(fireEvent.keyDown(box(), { key: 'Tab' })).toBe(true)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('@data-analyst')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('@general')
    fireEvent.change(box(), { target: { value: '@da', selectionStart: 3 } })
    expect(fireEvent.keyDown(box(), { key: 'Tab', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(box(), { key: 'Tab' })).toBe(false)
    expect(box()).toHaveValue('@data-analyst ')
  })

  it('closes the list on Escape and chooses with the pointer', async () => {
    render(<Harness />)
    fireEvent.change(box(), { target: { value: '@g', selectionStart: 2 } })
    await screen.findByRole('listbox')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.change(box(), { target: { value: '@ge', selectionStart: 3 } })
    fireEvent.click(await screen.findByRole('option', { name: /general/i }))
    await waitFor(() => expect(box()).toHaveValue('@general '))
  })

  it('shows who each suggestion is with the official Avatar, and says when one cannot receive yet', async () => {
    render(<Harness mentions={[
      { id: 'g', handle: 'general', label: 'General', identity: { role: 'manager', roleLabel: 'Project manager' } },
      { id: 'w', handle: 'writer', label: 'Writer', identity: { role: 'specialist', roleLabel: 'Specialist · Writing', unavailable: "Can't receive messages yet" } },
    ]} />)
    fireEvent.change(box(), { target: { value: '@', selectionStart: 1 } })
    const options = await screen.findAllByRole('option')
    // The row says who the member is: name, handle, then the quiet role line.
    expect(options[0]).toHaveTextContent('GGeneral@general · Project manager')
    expect(options[0].querySelector('[data-slot="avatar"]')).not.toBeNull()
    expect(options[1]).toHaveTextContent("Can't receive messages yet")
  })

  it('is a plain text box when nobody can be mentioned or it is disabled', () => {
    const { rerender } = render(<Harness mentions={[]} />)
    const plain = screen.getByRole('textbox', { name: 'Message' })
    expect(plain).not.toHaveAttribute('aria-expanded')
    fireEvent.change(plain, { target: { value: '@g', selectionStart: 2 } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    rerender(<Harness disabled initial="@g" />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('says why it cannot send, linked to the send button, and gives the caller its text box', () => {
    const ref = { current: null as HTMLTextAreaElement | null }
    render(<Harness canSend={false} focusKey="composer:general" initial="@writer hi" sendDisabledReason="Writer can't receive messages yet." textareaRef={ref} />)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription("Writer can't receive messages yet.")
    expect(ref.current).toBe(box())
    expect(box()).toHaveAttribute('data-focus-key', 'composer:general')
  })
})
