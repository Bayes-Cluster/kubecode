import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AiMessage } from '@/components/AiMessage'
import { createTranslator } from '@/lib/i18n'

import type { DmTurn, KubecodeApi, ProjectContextDocument, ResearchSummary } from '../api'
import { MessageItem } from '../channel/MessageItem'
import { DmPane } from '../dm/DmPane'
import { DmShareDialog } from '../dm/DmShareDialog'
import { memberDirectory, MemberDirectoryContext } from '../members/memberDirectory'
import { channelMessage, general, member } from '../members/memberFixtures'
import { authorView, messageRecipients } from '../members/memberIdentity'
import { RecordPreview } from '../resources/RecordPreview'

const t = createTranslator('en')
const analyst = member({ id: 'm1', name: 'Analyst', handle: 'analyst', public_conversation_id: 's-public', dm_conversation_id: 's-dm' })
const team = memberDirectory({ members: [general, analyst], general_id: 'g' }, 'ready')

/** Everything a message may carry: math, a table, a task list, a code fence, a wikilink, an image, and an attack. */
const SOURCE = [
  '# Results',
  '',
  'Accuracy $a_1 + b$ held, see [[Design Notes|the notes]] and ![loss curve](https://example.test/x.png).',
  '',
  '| model | acc |',
  '| --- | --- |',
  '| base | 0.91 |',
  '',
  '- [x] prune',
  '- [ ] retrain',
  '',
  '```python',
  'print(1)',
  '```',
  '',
  '$$\\sum_i x_i$$',
  '',
  'Then [bad](javascript:alert(1)) and [web](https://example.com/a).',
  '',
  '<script>alert(1)</script> <b>raw</b>',
].join('\n')

/** The rendered markdown without React's per-tree ids, which differ between two trees of the same source. */
function normalise(root: Element): string {
  return root.innerHTML.replace(/\s(?:id|for|aria-controls|aria-describedby|aria-labelledby)="[^"]*"/g, '')
}

/** What every surface owes the reader (ADR 0241 §4): no markup, no unsafe link, the content rendered. */
function expectHardenedAndRendered(root: HTMLElement, { images }: { images: 'badge' | 'text' | 'render' }) {
  expect(root.querySelector('script')).toBeNull()
  expect(root.querySelector('b')).toBeNull()
  // A conversation or a record never fetches an image; the Session (the researcher's own agent, ADR 0241 §4) does.
  if (images !== 'render') expect(root.querySelector('img')).toBeNull()
  expect(root.querySelector('[href*="javascript"], [src*="javascript"]')).toBeNull()
  expect(root.innerHTML).not.toContain('javascript:')
  expect(root.textContent).toContain('bad')
  expect(root.querySelector('a[href="https://example.com/a"]')).not.toBeNull()
  expect(root.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2)
  expect(root.querySelector('table')).not.toBeNull()
  expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
  expect(root.textContent).toContain('print(1)')
  if (images === 'render') {
    expect(root.querySelector('img[alt="loss curve"]')).not.toBeNull()
  } else {
    expect(root.textContent).toContain('loss curve')
  }
  if (images === 'badge') {
    expect(within(root).getByText('loss curve')).toHaveAttribute('data-slot', 'badge')
    expect(within(root).getByText('loss curve')).toHaveAttribute('data-variant', 'outline')
  }
  // No legacy renderer anywhere under the surface.
  expect(root.querySelector('.ai-markdown, .chat-wikilink, .kubecode-inert-image, [class*="hljs"]')).toBeNull()
}

function generalMessage(body: string) {
  const message = channelMessage(3, { author_kind: 'agent', author_ref: 's-old', author_member_id: 'g', body })
  const on = { reply: vi.fn(), openTask: vi.fn(), filterTask: vi.fn(), openReference: vi.fn(), openThread: vi.fn(), jump: vi.fn(), copyLink: vi.fn(), copyText: vi.fn() }
  return render(
    <MessageItem
      author={authorView(message, team, [], t)}
      cited={null}
      coarse={false}
      continued={false}
      dateLocale="en-US"
      delivery={null}
      filtered={false}
      message={message}
      on={on}
      recipients={messageRecipients(message, team, [], t)}
      references={[]}
      t={t}
      task={null}
    />,
  )
}

async function sharePreview(text: string) {
  const api = {
    previewDmShare: vi.fn().mockResolvedValue({ text, digest: 'd1', task_id: null }),
    shareDm: vi.fn(),
  } as unknown as KubecodeApi
  const turns: DmTurn[] = [{ run_id: 'run-1', user: 'is 0.91 enough?', assistant: 'It is.' }]
  render(
    <MemberDirectoryContext.Provider value={team}>
      <DmShareDialog api={api} member={analyst} open projectId="p1" research={[] as ResearchSummary[]} t={t} turns={turns} onOpenChange={vi.fn()} onShared={vi.fn()} />
    </MemberDirectoryContext.Provider>,
  )
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /is 0.91 enough/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
  return within(dialog).findByRole('region', { name: 'Preview' })
}

function recordPreview(text: string) {
  const doc: ProjectContextDocument = {
    ref: { kind: 'file', id: 'notes.md', revision: 'a1' },
    detail: 'content',
    title: 'notes.md',
    availability: 'available',
    provenance: { author: null, updated_at: null, research_id: null, parent: null, state: null },
    sections: [{ heading: 'Content', text, truncated: false }],
    related: [],
    next_cursor: null,
    notes: [],
    shown_revision: 'a1',
  }
  const api = { readProjectContext: vi.fn().mockResolvedValue(doc) } as unknown as KubecodeApi
  return render(<RecordPreview api={api} events={[]} projectId="p1" t={t} target={{ kind: 'file', id: 'notes.md' }} />)
}

// #278: one Markdown renderer. The official MessageResponse, through the two
// Kubecode adapters, draws every surface; the hardening lives in one file.
describe('one Markdown renderer', () => {
  it('renders the DM share preview and the General message from the same DOM', async () => {
    const message = generalMessage(SOURCE)
    const inGeneral = message.container.querySelector('[data-testid="conversation-response"]')!
    expect(inGeneral).not.toBeNull()
    const card = await sharePreview(SOURCE)
    const inPreview = within(card).getByTestId('conversation-response')
    // The preview is the official user Message, as the researcher's own messages are.
    expect(inPreview.closest('.is-user')).not.toBeNull()
    await waitFor(() => expect(normalise(inPreview)).toBe(normalise(inGeneral)), { timeout: 5000 })
    expectHardenedAndRendered(inPreview, { images: 'badge' })
  })

  it('neutralises raw HTML and unsafe links, and renders the content, on every surface', async () => {
    const message = generalMessage(SOURCE)
    expectHardenedAndRendered(message.container.querySelector<HTMLElement>('[data-testid="conversation-response"]')!, { images: 'badge' })
    message.unmount()

    const dmApi = {
      memberDmTurns: vi.fn().mockResolvedValue([{ run_id: 'run-1', user: 'hi', assistant: SOURCE }]),
      sendMemberDm: vi.fn(),
    } as unknown as KubecodeApi
    const dm = render(
      <MemberDirectoryContext.Provider value={team}>
        <DmPane api={dmApi} connectionState="live" events={[]} member={analyst} projectId="p1" research={[]} t={t} />
      </MemberDirectoryContext.Provider>,
    )
    const inDm = await screen.findAllByTestId('conversation-response')
    expectHardenedAndRendered(inDm[inDm.length - 1], { images: 'badge' })
    dm.unmount()

    const onNavigateWikilink = vi.fn()
    const session = render(<AiMessage actions={[]} messageId="run-1" onNavigateWikilink={onNavigateWikilink} response={SOURCE} userMessage="Where?" />)
    const segment = screen.getByTestId('ai-response-segment')
    expectHardenedAndRendered(segment, { images: 'render' })
    expect(segment.closest('.ai-markdown')).toBeNull()
    // A wikilink is a Badge around a real link: reached by Tab, followed by Enter or a click.
    const link = screen.getByRole('link', { name: 'the notes' })
    expect(link).toHaveAttribute('data-slot', 'badge')
    expect(link).toHaveAttribute('href')
    link.focus()
    expect(link).toHaveFocus()
    fireEvent.click(link)
    expect(onNavigateWikilink).toHaveBeenCalledWith('Design Notes')
    session.unmount()

    const record = recordPreview(SOURCE)
    expect(await screen.findByRole('heading', { name: 'Results' })).toBeInTheDocument()
    expectHardenedAndRendered(record.container.querySelector('[data-testid="evidence-viewer"]')!, { images: 'text' })
    expect(record.container.querySelector('[data-testid="evidence-viewer"]')!.innerHTML).not.toContain('example.test')
  })
})
