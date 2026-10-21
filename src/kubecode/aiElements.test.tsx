import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
  InlineCitationText,
  Loader,
  Message,
  MessageActions,
  MessageContent,
  PromptInput,
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
  Shimmer,
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
  Suggestion,
  Suggestions,
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements'

describe('AI Elements adaptations (ADR 0233)', () => {
  it('names the conversation log and offers a way back to the latest message once the reader scrolls away', () => {
    render(
      <Conversation label="General">
        <ConversationContent><p>hello</p></ConversationContent>
        <ConversationScrollButton label="Jump to latest" />
      </Conversation>,
    )
    const log = screen.getByRole('log', { name: 'General' })
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
    log.scrollTop = 100
    fireEvent.scroll(log)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(log.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('shows a caller-worded empty state', () => {
    render(<ConversationEmptyState description="Say hi" title="Nothing yet" />)
    expect(screen.getByText('Nothing yet')).toBeInTheDocument()
    expect(screen.getByText('Say hi')).toBeInTheDocument()
  })

  it('marks who a message is from and its delivery state, with named actions', () => {
    render(
      <Message author={<span>Mei</span>} from="self" state="failed">
        <MessageContent>text</MessageContent>
        <MessageActions label="Message actions"><button type="button">Reply</button></MessageActions>
      </Message>,
    )
    const article = screen.getByRole('article')
    expect(article).toHaveAttribute('data-from', 'self')
    expect(article).toHaveAttribute('data-state', 'failed')
    expect(screen.getByRole('toolbar', { name: 'Message actions' })).toBeInTheDocument()
  })

  it('opens an inline citation from a named button', async () => {
    render(
      <InlineCitation>
        <InlineCitationText>claim</InlineCitationText>
        <InlineCitationCard>
          <InlineCitationCardTrigger index="1" label="Source 1: notes" />
          <InlineCitationCardBody><InlineCitationSource description="Opens here">notes.md</InlineCitationSource></InlineCitationCardBody>
        </InlineCitationCard>
      </InlineCitation>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Source 1: notes' }))
    expect(await screen.findByText('Opens here')).toBeInTheDocument()
  })

  it('discloses sources, activity, internal work, and tool details', () => {
    render(
      <>
        <Sources><SourcesTrigger label="Sources (1)" /><SourcesContent><Source>notes.md</Source></SourcesContent></Sources>
        <ChainOfThought>
          <ChainOfThoughtHeader>Activity</ChainOfThoughtHeader>
          <ChainOfThoughtContent><ChainOfThoughtStep label="Seed 1" status="active" statusLabel="In progress" /></ChainOfThoughtContent>
        </ChainOfThought>
        <Task defaultOpen={false}><TaskTrigger title="Plan" /><TaskContent><TaskItem>step</TaskItem></TaskContent></Task>
        <Tool>
          <ToolHeader state="failed" stateLabel="Failed" title="launch" />
          <ToolContent>
            <ToolInput input="{}" label="Input" />
            <ToolOutput errorText="boom" label="Error" />
            <ToolOutput label="Nothing" />
          </ToolContent>
        </Tool>
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sources (1)' }))
    expect(screen.getByText('notes.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))
    expect(screen.getByText('In progress')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(screen.getByText('step')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /launch/ }))
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.queryByText('Nothing')).toBeNull()
  })

  it('shows a confirmation’s actions only while the decision is requested', () => {
    const { rerender } = render(
      <Confirmation state="requested">
        <ConfirmationTitle>Allow launch?</ConfirmationTitle>
        <ConfirmationRequest>asking</ConfirmationRequest>
        <ConfirmationAccepted>allowed</ConfirmationAccepted>
        <ConfirmationRejected>declined</ConfirmationRejected>
        <ConfirmationActions><button type="button">Allow</button></ConfirmationActions>
      </Confirmation>,
    )
    expect(screen.getByRole('region', { name: 'Allow launch?' })).toBeInTheDocument()
    expect(screen.getByText('asking')).toBeInTheDocument()
    rerender(
      <Confirmation state="approved">
        <ConfirmationTitle>Allow launch?</ConfirmationTitle>
        <ConfirmationAccepted>allowed</ConfirmationAccepted>
        <ConfirmationRejected>declined</ConfirmationRejected>
        <ConfirmationActions><button type="button">Allow</button></ConfirmationActions>
      </Confirmation>,
    )
    expect(screen.getByText('allowed')).toBeInTheDocument()
    expect(screen.queryByText('declined')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(() => render(<ConfirmationTitle>x</ConfirmationTitle>)).toThrow()
  })

  it('lists queued work in a focusable, named region', () => {
    render(
      <Queue>
        <QueueSection>
          <QueueSectionTrigger><QueueSectionLabel label="Running (1)" /></QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList label="Running (1)">
              <QueueItem completed><QueueItemIndicator completed /><QueueItemContent>sweep</QueueItemContent></QueueItem>
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      </Queue>,
    )
    expect(screen.getByRole('region', { name: 'Running (1)' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByText('sweep').closest('li')).toHaveAttribute('data-completed', 'true')
  })

  it('fills the draft from a suggestion without sending', () => {
    const fill = vi.fn()
    render(<Suggestions label="Suggested drafts"><Suggestion suggestion="Summarize" onClick={fill} /></Suggestions>)
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }))
    expect(fill).toHaveBeenCalledWith('Summarize')
    expect(screen.getByRole('group', { name: 'Suggested drafts' })).toBeInTheDocument()
  })

  it('announces loading in words and marks a busy composer card', () => {
    render(<><Loader label="Writing…" /><Shimmer>Writing</Shimmer><PromptInput busy data-testid="card" /></>)
    expect(screen.getByRole('status')).toHaveTextContent('Writing…')
    expect(screen.getByTestId('card')).toHaveAttribute('aria-busy', 'true')
  })
})
