import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { ChannelThread, KubecodeApi, ProjectContextRef } from '../api'
import { memberDirectory } from '../members/memberDirectory'
import { analyst, channelMessage, general, writer } from '../members/memberFixtures'
import { authorView, memberView, messageRecipients, researcherView } from '../members/memberIdentity'
import { ReferenceResolverProvider } from '../resources/ReferenceResolverProvider'
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
    dateLocale: 'en-US',
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

describe('MessageItem references', () => {
  it('names each cited record by kind, title and the version cited, says when it changed, and never shows an id', async () => {
    const resolveProjectContext = vi.fn().mockImplementation((_p: string, refs: ProjectContextRef[]) => Promise.resolve(refs.map((ref) => ({
      ref, availability: 'changed', current_revision: 'ffffffffffffffff', title: 'results/summary.csv',
    }))))
    const message = channelMessage(4, { body: 'compare', task_id: null })
    const on = {
      reply: vi.fn(), openTask: vi.fn(), filterTask: vi.fn(), openReference: vi.fn(), openThread: vi.fn(),
      jump: vi.fn(), copyLink: vi.fn(), copyText: vi.fn(),
    }
    const ref = { kind: 'file' as const, id: 'results/summary.csv', revision: '3f2c1a9e5b7d4c6a8e0f' }
    render(
      <ReferenceResolverProvider api={{ resolveProjectContext } as unknown as KubecodeApi} events={[]} projectId="p1">
        <MessageItem
          author={authorView(message, directory, [], t)}
          cited={null}
          coarse={false}
          continued={false}
          dateLocale="en-US"
          delivery={null}
          filtered={false}
          message={message}
          on={on}
          recipients={messageRecipients(message, directory, [], t)}
          references={[{ ref, kind: 'file', kindLabel: 'File', title: 'results/summary.csv' }]}
          t={t}
          task={null}
        />
      </ReferenceResolverProvider>,
    )
    const chip = await screen.findByRole('button', { name: 'File results/summary.csv #3f2c1a9 Changed since cited' })
    expect(screen.getByRole('article')).not.toHaveTextContent('3f2c1a9e5b7d')
    fireEvent.click(chip)
    expect(on.openReference).toHaveBeenCalledWith(ref)
  })
})

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

  it('folds whom a message was handed to into its author line, behind an arrow, keeping the words for screen readers', () => {
    const { article } = item()
    const header = article.querySelector('.kubecode-message-header') as HTMLElement
    const recipients = header.querySelector('.kubecode-message-recipients') as HTMLElement
    expect(recipients).not.toBeNull()
    expect(within(recipients).getByText('Handed to')).toHaveClass('sr-only')
    expect(recipients.querySelector('[data-testid="recipients-arrow"]')).toHaveAttribute('aria-hidden', 'true')
    expect(within(recipients).getByText('Analyst')).toBeInTheDocument()
  })

  it('renders the body as Markdown and shows the Task once, as a chip that opens it', () => {
    const { article, on } = item()
    expect(within(article).getByText('prune').tagName).toBe('STRONG')
    const chips = article.querySelectorAll('[data-reference-state]')
    expect(chips).toHaveLength(1)
    fireEvent.click(within(article).getByRole('button', { name: 'Task Structured pruning' }))
    expect(on.openTask).toHaveBeenCalled()
  })

  it('drops the Task chip while General shows only that Task, so it is not repeated under every message', () => {
    const { article } = item({ filtered: true })
    expect(article.querySelectorAll('[data-reference-state]')).toHaveLength(0)
    expect(within(article).queryByRole('button', { name: 'Task Structured pruning' })).not.toBeInTheDocument()
  })

  it('still opens the Task from More actions while General shows only that Task', async () => {
    const { on } = item({ filtered: true })
    const items = await openMore(/More actions/)
    fireEvent.click(items.find((entry) => entry.textContent === 'Open the Task') as HTMLElement)
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
    // A failure is the official destructive Alert.
    expect(row).toHaveAttribute('data-slot', 'alert')
    expect(row).toHaveTextContent('Not delivered')
    expect(row).toHaveTextContent('Writer needs setup.')
    const items = await openMore("More actions for You's message")
    expect(items.map((entry) => entry.textContent)).toContain('Open earlier thread')
  })

  it('says quietly, in words, when a message is waiting to be delivered or was delivered, as a delivery source reports it', () => {
    const message = channelMessage(6)
    const view = item({ message, author: researcherView(t), task: null, delivery: { state: 'queued', recipients: ['Analyst', 'Writer'] } })
    let row = view.article.querySelector('[data-delivery]')
    expect(row).toHaveAttribute('data-delivery', 'queued')
    expect(row).toHaveTextContent('Waiting to reach Analyst and Writer')
    expect(row?.querySelector('[data-slot="badge"]')).toBeNull()
    cleanup()
    const delivered = item({ message, author: researcherView(t), task: null, delivery: { state: 'delivered', recipients: ['Analyst'] } })
    row = delivered.article.querySelector('[data-delivery]')
    expect(row).toHaveAttribute('data-delivery', 'delivered')
    expect(row).toHaveTextContent('Reached Analyst')
    cleanup()
    const nobody = item({ message, author: researcherView(t), task: null, delivery: { state: 'delivered', recipients: [] } })
    expect(nobody.article.querySelector('[data-delivery]')).toHaveTextContent(/^Delivered$/)
  })

  it('counts one reply in the singular, and in other languages in a form that fits any count', () => {
    const one = { id: 't1', reply_count: 1 } as ChannelThread
    item({ message: channelMessage(5), author: researcherView(t), task: null, legacyThread: one })
    expect(screen.getByRole('button', { name: 'Earlier thread · 1 reply' })).toBeInTheDocument()
    expect(createTranslator('de-DE')('kubecode.channel.legacyThread.open', { count: 1, plural: 'y' }))
      .toBe('Früherer Thread · Antworten: 1')
  })

  it('cites what it replies to and jumps there, even when it is not loaded', () => {
    const message = channelMessage(6, { reply_to: 'm1' })
    const { on } = item({ message, author: researcherView(t), task: null, cited: { author: memberView(analyst, t), excerpt: 'Ran it' } })
    const citation = screen.getByRole('button', { name: 'In reply to Analyst: Ran it' })
    // The official link Button, not a handcrafted control (#263).
    expect(citation).toHaveAttribute('data-slot', 'button')
    fireEvent.click(citation)
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

describe('MessageItem as a conversation message (#232)', () => {
  it('tints the researcher\'s own message, reads a member\'s as a member\'s, and keeps the body as safe Markdown', () => {
    const { article } = item()
    expect(article).toHaveAttribute('data-from', 'member')
    expect(article.querySelector('.kubecode-message-body strong')).toHaveTextContent('prune')
    cleanup()
    const own = channelMessage(5, { author_kind: 'researcher', body: 'mine <script>x</script>', task_id: null })
    const { article: mine } = item({ message: own })
    expect(mine).toHaveAttribute('data-from', 'self')
    expect(mine.querySelector('script')).toBeNull()
    // Right-aligned like a chat: only the time shows; the author stays in the accessible name.
    expect(mine).toHaveAccessibleName('You')
    expect(within(mine).queryByText('You', { selector: ':not(.sr-only)' })).not.toBeInTheDocument()
    expect(mine.querySelector('time')).not.toBeNull()
  })

  it('marks a message that was not delivered as failed, and one still on its way as pending', () => {
    const own = channelMessage(6, { author_kind: 'researcher', body: 'to the analyst', task_id: null })
    const { article } = item({ message: own, delivery: { state: 'failed', text: 'The analyst is gone.' } })
    expect(article).toHaveAttribute('data-state', 'failed')
    cleanup()
    const { article: queued } = item({ message: own, delivery: { state: 'queued', recipients: [] } })
    expect(queued).toHaveAttribute('data-state', 'pending')
  })
})
