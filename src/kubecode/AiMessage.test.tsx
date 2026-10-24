import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AiMessage } from '@/components/AiMessage'

describe('AiMessage', () => {
  it('edits a user message inline before regenerating', () => {
    const onEdit = vi.fn()
    render(
      <AiMessage
        actions={[]}
        messageId="run-1"
        onEdit={onEdit}
        response="Original response"
        userMessage="Original prompt"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const editor = screen.getByRole('textbox', { name: 'Edit message' })
    fireEvent.change(editor, { target: { value: 'Updated prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    expect(onEdit).toHaveBeenCalledWith('run-1', 'Updated prompt')
  })

  it('offers only copy and edit actions for a user message', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <AiMessage
        actions={[]}
        messageId="run-1"
        onEdit={vi.fn()}
        userMessage="Copy this prompt"
      />,
    )

    const actions = screen.getByTestId('ai-user-message-actions')
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Copy message' }))
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Edit message' }))
    expect(actions.querySelectorAll('button')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy this prompt'))
  })

  it('keeps an internally woken teammate response visible without a fake user bubble', () => {
    render(
      <AiMessage
        actions={[]}
        internal
        messageId="team-run-1"
        response="I reviewed the backend and submitted the result."
        userMessage="Kubecode Team mailbox has new updates"
      />,
    )

    expect(screen.getByText('I reviewed the backend and submitted the result.')).toBeInTheDocument()
    expect(screen.queryByText('Kubecode Team mailbox has new updates')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ai-user-message-actions')).not.toBeInTheDocument()
  })

  it('renders tool work as compact rows and expands details on demand', () => {
    render(
      <AiMessage
        actions={[{
          tool: 'Bash',
          toolId: 'tool-1',
          label: 'Run test suite',
          status: 'done',
          input: '{"command":"pnpm test"}',
          output: '129 tests passed',
        }]}
        messageId="run-1"
        response="The tests pass."
        userMessage="Run the tests"
      />,
    )

    fireEvent.click(screen.getByTestId('tool-use-toggle'))
    const row = screen.getByTestId('ai-action-card')
    expect(row).toHaveAttribute('data-density', 'compact')
    expect(screen.queryByTestId('action-card-details')).not.toBeInTheDocument()

    const header = screen.getByRole('button', { name: /Run test suite/ })
    expect(header).toHaveTextContent('Done')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('detail-input')).toHaveTextContent('Input')
    expect(screen.getByTestId('detail-input')).toHaveTextContent('pnpm test')
    expect(screen.getByTestId('detail-output')).toHaveTextContent('Output')
    expect(screen.getByTestId('detail-output')).toHaveTextContent('129 tests passed')

    fireEvent.keyDown(header, { key: 'Escape' })
    expect(screen.queryByTestId('action-card-details')).not.toBeInTheDocument()
  })

  it('renders provider messages as separate response blocks and copies them with a blank line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <AiMessage
        actions={[]}
        messageId="run-1"
        responseBlocks={[
          { id: 'message-1', text: 'First provider message.' },
          { id: 'message-2', text: 'Second provider message.' },
        ]}
        userMessage="Keep working"
      />,
    )

    expect(screen.getAllByTestId('ai-response-segment')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Copy response' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      'First provider message.\n\nSecond provider message.',
    ))
  })

  it('labels tool work in the reader\'s language and shows a failed call under Error', () => {
    render(
      <AiMessage
        actions={[{
          tool: 'Bash',
          toolId: 'tool-1',
          label: 'pnpm build',
          status: 'error',
          input: '{"command":"pnpm build"}',
          output: 'error TS2304',
        }]}
        locale="de-DE"
        messageId="run-1"
        userMessage="Build"
      />,
    )

    fireEvent.click(screen.getByTestId('tool-use-toggle'))
    const header = screen.getByRole('button', { name: /pnpm build/ })
    expect(header).toHaveTextContent('Fehlgeschlagen')
    fireEvent.click(header)
    expect(screen.getByTestId('detail-input')).toHaveTextContent('Eingabe')
    expect(screen.getByTestId('detail-output')).toHaveTextContent('Fehler')
    expect(screen.getByTestId('detail-output')).toHaveTextContent('error TS2304')
    for (const english of ['Parameters', 'Result', 'Completed', 'Running']) {
      expect(screen.getByTestId('ai-message')).not.toHaveTextContent(english)
    }
  })

  it('opens a file directly from a tool call without details', () => {
    const onOpenNote = vi.fn()
    render(
      <AiMessage
        actions={[{ tool: 'Read', toolId: 'tool-1', label: 'Read README.md', path: 'README.md', status: 'done' }]}
        messageId="run-1"
        onOpenNote={onOpenNote}
        userMessage="Read it"
      />,
    )

    fireEvent.click(screen.getByTestId('tool-use-toggle'))
    fireEvent.click(screen.getByRole('button', { name: /Read README.md/ }))
    expect(onOpenNote).toHaveBeenCalledWith('README.md')
    expect(screen.queryByTestId('action-card-details')).not.toBeInTheDocument()
  })

  it('renders hardened markdown with wikilinks that navigate', async () => {
    const onNavigateWikilink = vi.fn()
    render(
      <AiMessage
        actions={[]}
        messageId="run-1"
        onNavigateWikilink={onNavigateWikilink}
        response={'See [[Design Notes|the notes]] and <b>raw</b> [bad](javascript:alert(1)).'}
        userMessage="Where?"
      />,
    )

    const link = await screen.findByRole('link', { name: 'the notes' })
    // A Badge around the anchor (#278): keyboard-reachable like any link, no legacy chip class.
    expect(link).toHaveAttribute('data-slot', 'badge')
    expect(link).not.toHaveClass('chat-wikilink')
    link.focus()
    expect(link).toHaveFocus()
    fireEvent.click(link)
    expect(onNavigateWikilink).toHaveBeenCalledWith('Design Notes')
    expect(screen.getByTestId('ai-response-block').querySelector('b')).toBeNull()
    // The official MessageResponse owns the typography: no legacy wrapper around it.
    expect(screen.getByTestId('ai-response-block').querySelector('.ai-markdown')).toBeNull()
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
  })

  it('shows reasoning open while it streams and lets the reader close it', () => {
    const { rerender } = render(
      <AiMessage actions={[]} messageId="run-1" reasoning="Weighing options" reasoningDone={false} userMessage="Think" />,
    )
    const toggle = screen.getByTestId('reasoning-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('reasoning-content')).toHaveTextContent('Weighing options')
    expect(screen.getByTestId('reasoning-content')).not.toHaveClass('ai-reasoning-markdown')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    rerender(
      <AiMessage actions={[]} messageId="run-1" reasoning="Weighing options" reasoningDone userMessage="Think" />,
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows a localized working indicator before the first response text', () => {
    render(<AiMessage actions={[]} isStreaming locale="de-DE" messageId="run-1" userMessage="Go" />)
    expect(screen.getByTestId('ai-streaming-indicator')).toHaveTextContent('Arbeitet…')
  })
})
