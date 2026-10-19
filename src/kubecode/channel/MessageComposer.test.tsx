import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation, KubecodeApi } from '../api'
import { MessageComposer } from './MessageComposer'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const options = [
  { id: 's-general', handle: 'general', label: 'General' },
  { id: 's-analyst', handle: 'analyst', label: 'Analyst' },
]

function composer(onSend = vi.fn().mockResolvedValue(undefined), extra: object = {}) {
  render(
    <MessageComposer
      api={{} as unknown as KubecodeApi}
      mentionOptions={options}
      placeholder="Message General"
      projectId="p1"
      sessions={[{ id: 's-analyst', title: 'Analyst' }] as unknown as Conversation[]}
      t={t}
      onSend={onSend}
      {...extra}
    />,
  )
  return { onSend, box: screen.getByRole('combobox', { name: 'Message General' }) as HTMLTextAreaElement }
}

describe('MessageComposer on the shared Composer', () => {
  it('sends on Enter with the members it mentions, once, and keeps a retry on the same id', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)
    const { box } = composer(onSend)
    fireEvent.change(box, { target: { value: '@analyst please look, cc @general thanks', selectionStart: 40 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0]).toMatchObject({
      body: '@analyst please look, cc @general thanks',
      intent: 'say',
      mentions: [{ session_id: 's-general' }, { session_id: 's-analyst' }],
    })
    // The draft comes back after the failure, and the retry replays the same message.
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    await waitFor(() => expect(box.value).toBe('@analyst please look, cc @general thanks'))
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).toBe(onSend.mock.calls[0][0].clientMessageId)
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('does not send on Shift+Enter or while an input method composes', () => {
    const { box, onSend } = composer()
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    fireEvent.compositionStart(box)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('merges the asked Session with mentions and offers a named stop that does not block sending', async () => {
    const onStop = vi.fn()
    const { box, onSend } = composer(undefined, { stop: { target: 'Analyst', onStop } })
    fireEvent.change(screen.getByLabelText('kubecode.channel.intent.label'), { target: { value: 'ask' } })
    fireEvent.change(screen.getByLabelText('kubecode.channel.askSession'), { target: { value: 's-analyst' } })
    fireEvent.change(box, { target: { value: 'what do you think, @analyst?', selectionStart: 28 } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.composer.stopTarget:{"target":"Analyst"}' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.send' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0].mentions).toEqual([{ session_id: 's-analyst' }])
  })
})
