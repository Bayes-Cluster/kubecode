import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { ChannelThread } from '../api'
import { memberDirectory } from '../members/memberDirectory'
import { analyst, channelMessage, general, writer } from '../members/memberFixtures'
import { authorView, memberView, messageRecipients, researcherView } from '../members/memberIdentity'
import { MessageItem, type MessageItemProps } from './MessageItem'

const t = createTranslator('en')
const directory = memberDirectory({ members: [general, analyst, writer], general_id: 'g' }, 'ready')

function item(overrides: Partial<MessageItemProps> = {}) {
  const message = overrides.message ?? channelMessage(3, {
    author_kind: 'agent', author_ref: 's-old', author_member_id: 'g', body: 'Plan: **prune** first', task_id: 'r1',
    mentions: [{ session_id: '9142962f-0000' }], mention_member_ids: ['a'],
  })
  const on = {
    reply: vi.fn(), openTask: vi.fn(), filterTask: vi.fn(), openReference: vi.fn(), openThread: vi.fn(),
    jump: vi.fn(), copyLink: vi.fn(), copyText: vi.fn(),
  }
  const props: MessageItemProps = {
    message,
    author: authorView(message, directory, [], t),
    recipients: messageRecipients(message, directory, [], t),
    continued: false,
    cited: null,
    task: message.task_id ? { id: message.task_id, title: 'Structured pruning' } : null,
    references: [],
    delivery: null,
    filtered: false,
    coarse: false,
    t,
    on,
    ...overrides,
  }
  render(<MessageItem {...props} />)
  return { on, article: screen.getByRole('article') }
}

async function openMore(name: RegExp | string) {
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  return screen.findAllByRole('menuitem')
}

describe('MessageItem', () => {
  it('names its author and recipients as members, never by a Session id', () => {
    const { article } = item()
    expect(within(article).getByText('General')).toBeInTheDocument()
    expect(within(article).getByText('Project manager')).toBeInTheDocument()
    expect(within(article).getByText('Handed to')).toBeInTheDocument()
    expect(within(article).getByText('Analyst')).toBeInTheDocument()
    expect(article).not.toHaveTextContent('9142962f')
    expect(article).not.toHaveTextContent(/\bAgent\b/)
  })

  it('renders the body as Markdown and shows the Task once, as a chip that opens it', () => {
    const { article, on } = item()
    expect(within(article).getByText('prune').tagName).toBe('STRONG')
    const chips = article.querySelectorAll('.kubecode-reference-chip')
    expect(chips).toHaveLength(1)
    fireEvent.click(within(article).getByRole('button', { name: 'Task Structured pruning' }))
    expect(on.openTask).toHaveBeenCalled()
  })

  it('offers Reply and only the More actions that apply, and never a Thread of its own', async () => {
    const { on } = item()
    expect(screen.queryByText('Reply in thread')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reply to General' }))
    expect(on.reply).toHaveBeenCalled()
    const items = await openMore("More actions for General's message")
    expect(items.map((entry) => entry.textContent)).toEqual(['Copy link', 'Copy text', 'Show only messages about this Task'])
    fireEvent.click(items[0])
    expect(on.copyLink).toHaveBeenCalled()
  })

  it('on a touch screen shows only More, whose first item is Reply', async () => {
    const message = channelMessage(2, { body: 'hello' })
    const { on } = item({ message, author: researcherView(t), coarse: true, task: null, filtered: true })
    expect(screen.queryByRole('button', { name: 'Reply to You' })).not.toBeInTheDocument()
    const items = await openMore("More actions for You's message")
    expect(items.map((entry) => entry.textContent)).toEqual(['Reply', 'Copy link', 'Copy text'])
    fireEvent.click(items[0])
    expect(on.reply).toHaveBeenCalled()
  })

  it('opens an earlier thread, shows a legacy intent quietly, and says when a message was not delivered', async () => {
    const message = channelMessage(5, { intent: 'ask', intent_claimed_by: 's-a' })
    const thread = { id: 't1', reply_count: 3 } as ChannelThread
    const { on } = item({
      message, author: researcherView(t), task: null, legacyThread: thread,
      delivery: { state: 'failed', text: 'Your message was not delivered: Writer needs setup.' },
    })
    expect(screen.getByText('Ask a Session · picked up')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Earlier thread · 3 replies' }))
    expect(on.openThread).toHaveBeenCalled()
    const row = document.querySelector('[data-delivery="failed"]')
    expect(row).toHaveTextContent('Not delivered')
    expect(row).toHaveTextContent('Writer needs setup.')
    const items = await openMore("More actions for You's message")
    expect(items.map((entry) => entry.textContent)).toContain('Open earlier thread')
  })

  it('cites what it replies to and jumps there, even when it is not loaded', () => {
    const message = channelMessage(6, { reply_to: 'm1' })
    const { on } = item({ message, author: researcherView(t), task: null, cited: { author: memberView(analyst, t), excerpt: 'Ran it' } })
    fireEvent.click(screen.getByRole('button', { name: 'In reply to Analyst: Ran it' }))
    expect(on.jump).toHaveBeenCalledWith('m1')
  })

  it('names a removed author as plain text, and keeps the row’s anchors', () => {
    const message = channelMessage(7, { author_kind: 'agent', author_ref: 's-w', author_member_id: 'w' })
    const gone = memberDirectory({ members: [{ ...writer, state: 'removed' }], general_id: null }, 'ready')
    const { article } = item({ message, author: authorView(message, gone, [], t), recipients: { kind: 'none' }, task: null })
    expect(within(article).queryByRole('button', { name: 'Writer' })).not.toBeInTheDocument()
    expect(within(article).getByText('Removed')).toBeInTheDocument()
    expect(article).toHaveAttribute('data-focus-key', 'message:m7')
    expect(article).toHaveAttribute('data-scroll-anchor', 'm7')
    expect(article).toHaveAttribute('data-testid', 'message-7')
  })
})
