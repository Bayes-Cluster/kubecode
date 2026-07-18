import { createRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'

import { AiPanelComposer, AiPanelMessageHistory } from '@/components/AiPanelChrome'

vi.mock('@/components/AiMessage', () => ({
  AiMessage: ({ response }: AiAgentMessage) => <div>{response}</div>,
}))

const firstMessage: AiAgentMessage = {
  actions: [],
  id: 'run-1',
  isStreaming: true,
  response: 'First chunk',
  userMessage: 'Explain the project',
}

function renderHistory(messages: AiAgentMessage[]) {
  return render(
    <AiPanelMessageHistory
      agentLabel="Codex"
      agentReadiness="ready"
      hasContext
      isActive
      messages={messages}
    />,
  )
}

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  })
}

describe('AiPanelMessageHistory', () => {
  it('keeps streaming auto-follow inside the message timeline', async () => {
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
    scrollIntoView.mockClear()
    const { rerender } = renderHistory([firstMessage])
    const timeline = screen.getByTestId('ai-message-history')
    setScrollMetrics(timeline, 480, 200)

    rerender(
      <AiPanelMessageHistory
        agentLabel="Codex"
        agentReadiness="ready"
        hasContext
        isActive
        messages={[{ ...firstMessage, response: 'First chunk\nSecond chunk' }]}
      />,
    )

    await waitFor(() => expect(timeline.scrollTop).toBe(480))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('does not pull a reader back to the bottom after they scroll up', async () => {
    const { rerender } = renderHistory([firstMessage])
    const timeline = screen.getByTestId('ai-message-history')
    setScrollMetrics(timeline, 480, 200)
    timeline.scrollTop = 100
    fireEvent.scroll(timeline)

    setScrollMetrics(timeline, 620, 200)
    rerender(
      <AiPanelMessageHistory
        agentLabel="Codex"
        agentReadiness="ready"
        hasContext
        isActive
        messages={[{ ...firstMessage, response: 'A much longer streamed response' }]}
      />,
    )

    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(timeline.scrollTop).toBe(100)
  })
})

describe('AiPanelComposer', () => {
  it('keeps the editor writable while an Agent is running without submitting another prompt', () => {
    const onSend = vi.fn()
    render(
      <AiPanelComposer
        agentLabel="Codex"
        agentReadiness="ready"
        entries={[]}
        input="Prepare the follow-up"
        inputRef={createRef<HTMLDivElement>()}
        isActive
        onChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    )

    const input = screen.getByTestId('agent-input')
    expect(input).toHaveAttribute('contenteditable', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled()
  })

  it('keeps add, input, Agent settings, and send controls in one row', () => {
    render(
      <AiPanelComposer
        agentLabel="Codex"
        agentReadiness="ready"
        controls={<button type="button">Agent settings</button>}
        entries={[]}
        input="Implement it"
        inputRef={createRef<HTMLDivElement>()}
        isActive={false}
        leadingControl={<button type="button">Add context</button>}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    )

    const surface = screen.getByTestId('agent-composer-surface')
    expect(surface).toHaveAttribute('data-layout', 'single-row')
    expect(surface).toContainElement(screen.getByRole('button', { name: 'Add context' }))
    expect(surface).toContainElement(screen.getByRole('button', { name: 'Agent settings' }))
    expect(surface).toContainElement(screen.getByRole('button', { name: 'Send message' }))
  })

  it('keeps multiline prompts inside a fixed-height scrolling editor', () => {
    render(
      <AiPanelComposer
        agentLabel="Codex"
        agentReadiness="ready"
        controls={<button type="button">Agent settings</button>}
        entries={[]}
        input={Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n')}
        inputRef={createRef<HTMLDivElement>()}
        isActive={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    )

    expect(screen.getByTestId('agent-input')).toHaveStyle({
      maxHeight: '184px',
      minHeight: '32px',
      overflowY: 'auto',
    })
    expect(screen.getByTestId('agent-composer-surface')).toHaveClass(
      'min-h-[50px]',
      'max-h-[202px]',
    )
  })
})
