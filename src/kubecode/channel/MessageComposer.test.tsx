import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation, KubecodeApi, ProjectContextItem } from '../api'
import { createPlaceMemory, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { MessageComposer, type MessageComposerProps } from './MessageComposer'

const pickable = (id: string, title: string) => ({
  ref: { kind: 'research', id, revision: 3 },
  title,
}) as unknown as ProjectContextItem

// The picker is covered by its own tests; here it only hands back a reference.
vi.mock('../ComposerProjectWorkPicker', () => ({
  ComposerProjectWorkPicker: ({ onSelect }: { onSelect: (item: ProjectContextItem) => void }) => (
    <div>
      <button type="button" onClick={() => onSelect(pickable('r1', 'Pruning'))}>pick Pruning</button>
      <button type="button" onClick={() => onSelect(pickable('r2', 'Quantization'))}>pick Quantization</button>
    </div>
  ),
}))

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

  it('attaches references once, removes one, and sends the rest with their revisions', async () => {
    const { box, onSend } = composer()
    for (const name of ['pick Pruning', 'pick Pruning', 'pick Quantization']) {
      fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.attach' }))
      fireEvent.click(await screen.findByRole('button', { name: name }))
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.removeReference:{"title":"Pruning"}' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(box, { target: { value: 'see this' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0].references).toEqual([{ kind: 'research', id: 'r2', revision: 3 }])
    await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0))
  })

  it('puts the references back after a failed send and sends an edited draft as a new message', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)
    const { box } = composer(onSend)
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.attach' }))
    fireEvent.click(await screen.findByRole('button', { name: 'pick Pruning' }))
    fireEvent.change(box, { target: { value: 'first wording' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(box.value).toBe('first wording'))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(box, { target: { value: 'second wording' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).not.toBe(onSend.mock.calls[0][0].clientMessageId)
    await waitFor(() => expect(box.value).toBe('second wording'))
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3))
    expect(onSend.mock.calls[2][0].clientMessageId).toBe(onSend.mock.calls[1][0].clientMessageId)
  })

  it('writes into a Thread when one is given, and requires a Session to ask', async () => {
    const { box, onSend } = composer(undefined, { threadId: 'th1' })
    fireEvent.change(box, { target: { value: 'in the thread' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0].threadId).toBe('th1')
    fireEvent.change(screen.getByLabelText('kubecode.channel.intent.label'), { target: { value: 'ask' } })
    fireEvent.change(box, { target: { value: 'who?' } })
    expect(screen.getByRole('button', { name: 'kubecode.channel.send' })).toBeDisabled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('names its text box for focus return', () => {
    const { box } = composer(undefined, { focusKey: 'composer:general' })
    expect(box).toHaveAttribute('data-focus-key', 'composer:general')
  })
})

describe('MessageComposer drafts kept for the place (ADR 0228 §4)', () => {
  function placed(memory: PlaceMemory, children: ReactNode) {
    return <PlaceMemoryProvider memory={memory}>{children}</PlaceMemoryProvider>
  }

  function keyed(draftKey: string, onSend: MessageComposerProps['onSend'] = vi.fn().mockResolvedValue(undefined)) {
    return (
      <MessageComposer
        api={{} as unknown as KubecodeApi}
        draftKey={draftKey}
        mentionOptions={options}
        placeholder="Message General"
        projectId="p1"
        sessions={[{ id: 's-analyst', title: 'Analyst' }] as unknown as Conversation[]}
        t={t}
        onSend={onSend}
      />
    )
  }

  const box = () => screen.getByRole('combobox', { name: 'Message General' }) as HTMLTextAreaElement

  it('keeps the text, intent, and references when the composer is left and comes back', async () => {
    const memory = createPlaceMemory()
    const view = render(placed(memory, keyed('p1|general')))
    fireEvent.change(box(), { target: { value: 'half a thought' } })
    fireEvent.change(screen.getByLabelText('kubecode.channel.intent.label'), { target: { value: 'request' } })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.attach' }))
    fireEvent.click(await screen.findByRole('button', { name: 'pick Pruning' }))

    view.rerender(placed(memory, <p>elsewhere</p>))
    view.rerender(placed(memory, keyed('p1|general')))
    expect(box()).toHaveValue('half a thought')
    expect(screen.getByLabelText('kubecode.channel.intent.label')).toHaveValue('request')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)

    // Another place has its own draft.
    view.rerender(placed(memory, keyed('p1|general:task:r1')))
    expect(box()).toHaveValue('')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('replays the same message when a failed send is retried after coming back', async () => {
    const memory = createPlaceMemory()
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)
    const view = render(placed(memory, keyed('p1|general', onSend)))
    fireEvent.change(box(), { target: { value: 'try me' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(box()).toHaveValue('try me'))

    view.rerender(placed(memory, <p>elsewhere</p>))
    view.rerender(placed(memory, keyed('p1|general', onSend)))
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend.mock.calls[1][0].clientMessageId).toBe(onSend.mock.calls[0][0].clientMessageId)
    await waitFor(() => expect(box()).toHaveValue(''))

    // Sent: nothing is left to come back to.
    view.rerender(placed(memory, <p>elsewhere</p>))
    view.rerender(placed(memory, keyed('p1|general', onSend)))
    expect(box()).toHaveValue('')
  })

  it('puts a draft back into its place when the send fails after the place was left', async () => {
    const memory = createPlaceMemory()
    let fail: (cause: Error) => void = () => undefined
    const onSend = vi.fn(() => new Promise<void>((_, reject) => { fail = reject }))
    const view = render(placed(memory, keyed('p1|general', onSend)))
    fireEvent.change(box(), { target: { value: 'in flight' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    view.rerender(placed(memory, <p>elsewhere</p>))
    fail(new Error('network down'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.rerender(placed(memory, keyed('p1|general', onSend)))
    await waitFor(() => expect(box()).toHaveValue('in flight'))
  })
})
