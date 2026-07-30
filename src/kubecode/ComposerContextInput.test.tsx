import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ComposerCatalogSnapshot, KubecodeApi } from './api'
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
  onCatalogChange,
  onSubmit = vi.fn(),
  blockStaleSubmit = false,
}: {
  api: KubecodeApi
  blockStaleSubmit?: boolean
  conversationId?: string
  initial?: string | ComposerDraft
  onCatalogChange?: (catalog: ComposerCatalogSnapshot) => void
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
      onCatalogChange={onCatalogChange}
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
    version: 2,
    segments: [{
      kind: 'context',
      reference: createComposerContextReference({
        availability: 'available',
        catalogRevision: 7,
        id: 'restored-file',
        kind,
        name: 'main.ts',
        path: 'src/main.ts',
      }),
    }],
  }))
}

function composerApi(overrides: Partial<KubecodeApi> = {}): KubecodeApi {
  return {
    listSessionEntries: vi.fn().mockResolvedValue([]),
    registerComposerContext: vi.fn().mockImplementation((_conversationId, request) => Promise.resolve({
      context: {
        id: `ctx:${request.kind}:${request.path.replaceAll('/', ':')}`,
        kind: request.kind,
        display: request.path,
        enabled: true,
        disabled_reason: null,
      },
      catalog: {
        conversation_id: 'session-1',
        revision: 7,
        items: [],
        contexts: [],
      },
    })),
    validateComposerContexts: vi.fn().mockImplementation((_conversationId, references) => Promise.resolve({
      references: references.map((reference) => ({ ...reference, available: true })),
      catalog: {
        conversation_id: 'session-1',
        revision: 7,
        items: [],
        contexts: [],
      },
    })),
    ...overrides,
  } as unknown as KubecodeApi
}

describe('ComposerContextInput', () => {
  it('selects an inline file suggestion as a typed chip and removes it explicitly', async () => {
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
      { kind: 'directory', name: 'maps', path: 'src/maps' },
    ])
    render(<Harness api={composerApi({ listSessionEntries })} />)
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
    render(<Harness api={composerApi({ listSessionEntries })} />)
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
    render(<Harness api={composerApi({ listSessionEntries })} />)
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
    render(<Harness api={composerApi({ listSessionEntries })} />)
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

  it('does not retain a reference or catalog from a registration the editor discards', async () => {
    let resolveFirst: ((value: {
      context: { id: string; kind: 'file'; display: string; enabled: boolean; disabled_reason: null }
      catalog: { conversation_id: string; revision: number; items: never[]; contexts: never[] }
    }) => void) | undefined
    const listSessionEntries = vi.fn()
      .mockResolvedValueOnce([{ kind: 'file', name: 'main.ts', path: 'src/main.ts' }])
      .mockResolvedValueOnce([{ kind: 'file', name: 'second.ts', path: 'src/second.ts' }])
    const registerComposerContext = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({
        context: {
          id: 'ctx:second', kind: 'file', display: 'src/second.ts', enabled: true, disabled_reason: null,
        },
        catalog: { conversation_id: 'session-1', revision: 9, items: [], contexts: [] },
      })
    const onCatalogChange = vi.fn()
    render(
      <Harness
        api={composerApi({ listSessionEntries, registerComposerContext })}
        onCatalogChange={onCatalogChange}
      />,
    )
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    fireEvent.click(await screen.findByRole('option', { name: /main\.ts/i }))

    editor.textContent = '@se'
    placeCaretAtEnd(editor)
    fireEvent.input(editor)
    const second = await screen.findByRole('option', { name: /second\.ts/i })
    resolveFirst?.({
      context: {
        id: 'ctx:first', kind: 'file', display: 'src/main.ts', enabled: true, disabled_reason: null,
      },
      catalog: { conversation_id: 'session-1', revision: 8, items: [], contexts: [] },
    })
    await waitFor(() => expect(registerComposerContext).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('composer-context-chip')).not.toBeInTheDocument()
    expect(onCatalogChange).not.toHaveBeenCalled()

    fireEvent.click(second)
    expect(await screen.findByTestId('composer-context-chip')).toHaveAttribute(
      'title',
      'src/second.ts',
    )
    expect(onCatalogChange).toHaveBeenCalledTimes(1)
  })

  it('supports Tab selection and submits a readable fallback instead of the private token', async () => {
    const onSubmit = vi.fn()
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'directory', name: 'models', path: 'src/models' },
    ])
    render(
      <Harness
        api={composerApi({ listSessionEntries })}
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
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
    ])
    render(<Harness api={composerApi({ listSessionEntries })} />)
    const editor = screen.getByTestId('agent-input')
    placeCaretAtEnd(editor)
    fireEvent.click(await screen.findByRole('option', { name: /main\.ts/i }))
    expect(await screen.findAllByTestId('composer-context-chip')).toHaveLength(1)
    placeCaretAtEnd(editor)

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => type === 'text/plain' ? '[[ctx:file:src:main.ts]]' : '',
        items: [],
        types: ['text/plain'],
      },
    })

    expect(screen.getAllByTestId('composer-context-chip')).toHaveLength(1)
    expect(editor).toHaveTextContent('@src/main.ts')
  })

  it('does not select or submit on IME Enter and allows Escape to dismiss the picker', async () => {
    const onSubmit = vi.fn()
    const listSessionEntries = vi.fn().mockResolvedValue([
      { kind: 'file', name: 'main.ts', path: 'main.ts' },
    ])
    render(<Harness api={composerApi({ listSessionEntries })} onSubmit={onSubmit} />)
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
      catalogRevision: 7,
      id: 'restored-file',
      kind: 'file',
      name: 'removed.ts',
      path: 'src/removed.ts',
    })
    const initial: ComposerDraft = {
      version: 2,
      segments: [{ kind: 'context', reference }],
    }
    render(
      <Harness
        api={composerApi({
          validateComposerContexts: vi.fn().mockResolvedValue({
            references: [{
              id: 'restored-file',
              catalog_revision: 7,
              context_kind: 'file',
              available: false,
            }],
            catalog: { conversation_id: 'session-1', revision: 8, items: [], contexts: [] },
          }),
        })}
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
    const validateComposerContexts = vi.fn().mockRejectedValue(new Error('Session unavailable'))

    render(
      <Harness
        api={composerApi({ validateComposerContexts })}
        blockStaleSubmit
        initial={restoredDraft()}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
    await waitFor(() => expect(validateComposerContexts).toHaveBeenCalledWith('session-1', [{
      id: 'restored-file', catalog_revision: 7, context_kind: 'file',
    }]))
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
  })

  it('promotes a restored reference only after exact path and kind validation', async () => {
    let resolveValidation: ((response: {
      references: Array<{
        id: string
        catalog_revision: number
        context_kind: 'file'
        available: boolean
      }>
      catalog: { conversation_id: string; revision: number; items: never[]; contexts: never[] }
    }) => void)
      | undefined
    const validateComposerContexts = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveValidation = resolve
    }))

    render(
      <Harness
        api={composerApi({ validateComposerContexts })}
        blockStaleSubmit
        initial={restoredDraft()}
      />,
    )

    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
    resolveValidation?.({
      references: [{
        id: 'restored-file', catalog_revision: 7, context_kind: 'file', available: true,
      }],
      catalog: { conversation_id: 'session-1', revision: 7, items: [], contexts: [] },
    })
    await waitFor(() => {
      expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
        'data-context-availability',
        'available',
      )
    })
  })

  it('keeps a restored reference stale when the path now has a different kind', async () => {
    const validateComposerContexts = vi.fn().mockResolvedValue({
      references: [{
        id: 'restored-file',
        catalog_revision: 7,
        context_kind: 'directory',
        available: true,
      }],
      catalog: { conversation_id: 'session-1', revision: 7, items: [], contexts: [] },
    })

    render(
      <Harness
        api={composerApi({ validateComposerContexts })}
        blockStaleSubmit
        initial={restoredDraft()}
      />,
    )

    await waitFor(() => expect(validateComposerContexts).toHaveBeenCalled())
    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'stale',
    )
  })

  it('renders an unsupported capability segment as a removable send-locked chip', () => {
    const onSubmit = vi.fn()
    render(
      <Harness
        api={composerApi()}
        blockStaleSubmit
        initial={{
          version: 2,
          segments: [{
            kind: 'capability',
            reference: {
              availability: 'unsupported',
              catalogRevision: 7,
              id: 'cap:review',
              itemKind: 'skill',
              name: 'review',
            },
          }],
        }}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-kind',
      'capability',
    )
    expect(screen.getByTestId('composer-context-chip')).toHaveAttribute(
      'data-context-availability',
      'unsupported',
    )
    fireEvent.keyDown(screen.getByTestId('agent-input'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove context' }))
    expect(screen.queryByTestId('composer-context-chip')).not.toBeInTheDocument()
  })
})
