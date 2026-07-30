import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi } from './api'
import { ComposerContextInput } from './ComposerContextInput'
import {
  createComposerContextReference,
  composerDraftHasStaleContext,
  parseStoredComposerDraft,
  serializeComposerDraft,
  textComposerDraft,
  type ComposerDraft,
} from './composerDraft'

function Harness({
  api,
  conversationId = 'session-1',
  initial = '@ma',
  onSubmit = vi.fn(),
  blockStaleSubmit = false,
}: {
  api: KubecodeApi
  blockStaleSubmit?: boolean
  conversationId?: string
  initial?: string | ComposerDraft
  onSubmit?: (text: string) => void
}) {
  const [draft, setDraft] = useState<ComposerDraft>(
    typeof initial === 'string' ? textComposerDraft(initial) : initial,
  )
  const ref = useRef<HTMLDivElement>(null)
  return (
    <ComposerContextInput
      api={api}
      contextEmptyLabel="No context"
      contextErrorLabel="Context failed"
      contextLoadingLabel="Loading context"
      contextPickerLabel="Add context"
      contextRemoveLabel="Remove context"
      conversationId={conversationId}
      disabled={false}
      draft={draft}
      inputRef={ref}
      onChange={setDraft}
      onSubmit={onSubmit}
      placeholder="Ask Codex"
      submitDisabled={blockStaleSubmit && composerDraftHasStaleContext(draft)}
    />
  )
}

function placeCaretAtEnd(editor: HTMLElement) {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
  fireEvent.keyUp(editor, { key: 'a' })
}

function restoredDraft(kind: 'file' | 'directory' = 'file'): ComposerDraft {
  return parseStoredComposerDraft(serializeComposerDraft({
    version: 1,
    segments: [{
      kind: 'context',
      reference: createComposerContextReference({
        availability: 'available',
        localKey: 'restored-file',
        kind,
        name: 'main.ts',
        path: 'src/main.ts',
      }),
    }],
  }))
}

describe('ComposerContextInput', () => {
  it('selects an inline file suggestion as a typed chip and removes it explicitly', async () => {
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
      { kind: 'directory', name: 'maps', path: 'src/maps' },
    ])
    render(<Harness api={{ listSessionEntries } as unknown as KubecodeApi} />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)

    expect(await screen.findByRole('option', { name: /main\.ts/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /main\.ts/i }))

    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute('data-context-kind', 'file')
    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute('title', 'src/main.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Remove context' }))
    await waitFor(() => expect(screen.queryByTestId('composer-context-chip')).not.toBeInTheDocument())
  })

  it('supports touch selection without inserting the same context twice', async () => {
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
    ])
    render(<Harness api={{ listSessionEntries } as unknown as KubecodeApi} />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    const option = await screen.findByRole('option', { name: /main\.ts/i })
    const listbox = screen.getByRole('listbox', { name: 'Add context' })
    expect(editor).toHaveAttribute('aria-controls', listbox.id)
    expect(editor).toHaveAttribute('aria-activedescendant', option.id)

    fireEvent.pointerDown(option, { pointerType: 'touch' })
    fireEvent.click(option)
    expect(await screen.findAllByTestId('composer-context-chip')).toHaveLength(1)
  })

  it('moves the keyboard selection through results before accepting it', async () => {
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
      { kind: 'directory', name: 'maps', path: 'src/maps' },
    ])
    render(<Harness api={{ listSessionEntries } as unknown as KubecodeApi} />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    await screen.findByRole('option', { name: /main\.ts/i })

    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    const selected = screen.getByRole('option', { name: /maps/i })
    expect(selected).toHaveAttribute('aria-selected', 'true')
    expect(editor).toHaveAttribute('aria-activedescendant', selected.id)
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-kind',
      'directory',
    )
  })

  it('suppresses stale async results when the active query changes', async () => {
    let resolveFirst: ((value: Array<{ kind: 'file'; name: string; path: string }>) => void) | undefined
    const listSessionEntries = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce([{ kind: 'file', name: 'second.ts', path: 'second.ts' }])
    render(<Harness api={{ listSessionEntries } as unknown as KubecodeApi} />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    await waitFor(() => expect(listSessionEntries).toHaveBeenCalledTimes(1))

    editor.textContent = '@se'
    placeCaretAtEnd(editor)
    fireEvent.input(editor)
    await waitFor(() => expect(listSessionEntries).toHaveBeenCalledTimes(2))
    resolveFirst?.([{ kind: 'file', name: 'main.ts', path: 'main.ts' }])

    expect(await screen.findByRole('option', { name: /second\.ts/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /main\.ts/i })).not.toBeInTheDocument()
  })

  it('resets a dismissed query and aborts the old request when the Session changes', async () => {
    let firstSignal: AbortSignal | undefined
    const listSessionEntries = vi.fn()
      .mockImplementationOnce((_conversationId: string, _path: string, signal?: AbortSignal) => {
        firstSignal = signal
        return new Promise<Array<{ kind: 'file'; name: string; path: string }>>(() => {})
      })
      .mockResolvedValueOnce([{ kind: 'file', name: 'main.ts', path: 'main.ts' }])
    const api = { listSessionEntries } as unknown as KubecodeApi
    const { rerender } = render(<Harness api={api} conversationId="session-a" />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    await waitFor(() => expect(listSessionEntries).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('composer-context-menu')).not.toBeInTheDocument())

    rerender(<Harness api={api} conversationId="session-b" />)
    await waitFor(() => expect(firstSignal?.aborted).toBe(true))
    expect(await screen.findByRole('option', { name: /main\.ts/i })).toBeInTheDocument()
    expect(listSessionEntries).toHaveBeenLastCalledWith(
      'session-b',
      '',
      expect.any(AbortSignal),
    )
  })

  it('supports Tab selection and submits a readable fallback instead of the private token', async () => {
    const onSubmit = vi.fn()
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'directory', name: 'models', path: 'src/models' },
    ])
    render(
      <Harness
        api={{ listSessionEntries } as unknown as KubecodeApi}
        initial="@mod"
        onSubmit={onSubmit}
      />,
    )
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    await screen.findByRole('option', { name: /models/i })

    fireEvent.keyDown(editor, { key: 'Tab' })
    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-kind',
      'directory',
    )
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    selection?.removeAllRanges()
    selection?.addRange(range)
    const setData = vi.fn()
    fireEvent.copy(editor, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', '@src/models ')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('@src/models ')
  })

  it('keeps pasted private chip tokens as untrusted text', async () => {
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('known-context' as `${string}-${string}-${string}-${string}-${string}`)
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
    ])
    render(<Harness api={{ listSessionEntries } as unknown as KubecodeApi} />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    fireEvent.click(await screen.findByRole('option', { name: /main\.ts/i }))
    expect(await screen.findAllByTestId('composer-context-chip')).toHaveLength(1)
    placeCaretAtEnd(editor)

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => type === 'text/plain' ? '[[known-context]]' : '',
        items: [],
        types: ['text/plain'],
      },
    })

    expect(screen.getAllByTestId('composer-context-chip')).toHaveLength(1)
    expect(editor).toHaveTextContent('@src/main.ts')
    randomUuid.mockRestore()
  })

  it('does not select or submit on IME Enter and allows Escape to dismiss the picker', async () => {
    const onSubmit = vi.fn()
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'main.ts' },
    ])
    render(<Harness api={{ listSessionEntries } as unknown as KubecodeApi} onSubmit={onSubmit} />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    await screen.findByRole('option', { name: /main\.ts/i })

    fireEvent.compositionStart(editor)
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229, isComposing: true })
    for (const key of ['Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
      fireEvent.keyDown(editor, { key, keyCode: 229, isComposing: true })
    }
    expect(screen.queryByTestId('composer-context-chip')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-context-menu')).toBeInTheDocument()
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('composer-context-menu')).not.toBeInTheDocument())
  })

  it('marks a restored reference stale when it no longer exists', async () => {
    const onSubmit = vi.fn()
    const reference = createComposerContextReference({
      availability: 'stale',
      localKey: 'restored-file',
      kind: 'file',
      name: 'removed.ts',
      path: 'src/removed.ts',
    })
    const initial: ComposerDraft = {
      version: 1,
      segments: [{ kind: 'context', reference }],
    }
    render(
      <Harness
        api={{ listSessionEntries: vi.fn().mockResolvedValue([]) } as unknown as KubecodeApi}
        blockStaleSubmit
        initial={initial}
        onSubmit={onSubmit}
      />,
    )

    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps a persisted available reference stale and blocks Enter when validation rejects', async () => {
    const onSubmit = vi.fn()
    const listSessionEntries = vi.fn().mockRejectedValue(new Error('Session unavailable'))

    render(
      <Harness
        api={{ listSessionEntries } as unknown as KubecodeApi}
        blockStaleSubmit
        initial={restoredDraft()}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
    await waitFor(() => expect(listSessionEntries).toHaveBeenCalledWith(
      'session-1',
      'src',
      expect.any(AbortSignal),
    ))
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
  })

  it('promotes a restored reference only after exact path and kind validation', async () => {
    let resolveEntries: ((entries: Array<{ kind: 'file'; name: string; path: string }>) => void)
      | undefined
    const listSessionEntries = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveEntries = resolve
    }))

    render(
      <Harness
        api={{ listSessionEntries } as unknown as KubecodeApi}
        blockStaleSubmit
        initial={restoredDraft()}
      />,
    )

    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
    resolveEntries?.([{ kind: 'file', name: 'main.ts', path: 'src/main.ts' }])
    await waitFor(() => {
      expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
        'data-context-availability',
        'available',
      )
    })
  })

  it('keeps a restored reference stale when the path now has a different kind', async () => {
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'directory', name: 'main.ts', path: 'src/main.ts' },
    ])

    render(
      <Harness
        api={{ listSessionEntries } as unknown as KubecodeApi}
        blockStaleSubmit
        initial={restoredDraft()}
      />,
    )

    await waitFor(() => expect(listSessionEntries).toHaveBeenCalledWith(
      'session-1',
      'src',
      expect.any(AbortSignal),
    ))
    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
  })
})
