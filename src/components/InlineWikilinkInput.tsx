import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { VaultEntry } from '../types'
import type { NoteReference } from '../utils/ai-context'
import { buildTypeEntryMap } from '../utils/typeColors'
import {
  deleteInlineSelection,
  replaceInlineSelection,
  selectedInlineText,
} from './inlineWikilinkEdits'
import {
  buildInlineWikilinkSegments,
  extractInlineWikilinkReferences,
  findActiveWikilinkQuery,
} from './inlineWikilinkText'
import { extractDroppedPathText } from './inlineWikilinkDropText'
import {
  readSelectionRange,
  serializeInlineNode,
  type InlineSelectionRange,
} from './inlineWikilinkDom'
import {
  buildPendingPasteState,
  type PendingPasteState,
  shouldRecoverPendingPaste,
} from './inlineWikilinkPasteRecovery'
import {
  InlineWikilinkEditorField,
  InlineContextSuggestionList,
  InlineWikilinkPaletteLayout,
  InlineWikilinkSuggestionList,
} from './InlineWikilinkParts'
import { handleInlineWikilinkKeyDown } from './inlineWikilinkKeydown'
import { useInlineWikilinkSelection } from './useInlineWikilinkSelection'
import { useInlineWikilinkSuggestionsState } from './useInlineWikilinkSuggestionsState'
import { normalizeInlineWikilinkValue } from './inlineWikilinkTokens'
import {
  isInsertBeforeInput,
  isPlainTextBeforeInput,
} from './inlineWikilinkBeforeInput'
import { restorePendingRemountState } from './inlineWikilinkRemountState'
import type { InlineContextReference, InlineContextSuggestion } from './inlineContext'
import type { InlineCapabilitySuggestion } from './inlineContext'
import {
  findActiveComposerContextQuery,
  replaceActiveComposerContextQuery,
} from './inlineContextQuery'
import {
  findActiveComposerCapabilityQuery,
  replaceActiveComposerCapabilityQuery,
} from './inlineCapabilityQuery'

interface InlineWikilinkInputProps {
  entries: VaultEntry[]
  value: string
  onChange: (value: string) => void
  onSubmit?: (text: string, references: NoteReference[]) => void
  onUnsupportedPaste?: (message: string) => void
  submitOnEmpty?: boolean
  disabled?: boolean
  placeholder?: string
  placeholderClassName?: string
  inputRef?: React.RefObject<HTMLDivElement | null>
  dataTestId?: string
  editorClassName?: string
  editorStyle?: CSSProperties
  suggestionListVariant?: 'floating' | 'palette'
  suggestionEmptyLabel?: string
  paletteHeader?: ReactNode
  paletteEmptyState?: ReactNode
  paletteFooter?: ReactNode
  contextReferences?: InlineContextReference[]
  contextScopeKey?: string
  loadContextSuggestions?: (query: string, signal: AbortSignal) => Promise<InlineContextSuggestion[]>
  onContextSuggestionSelected?: (
    suggestion: InlineContextSuggestion,
  ) => InlineContextSelection | string | null | Promise<InlineContextSelection | string | null>
  onRemoveContext?: (id: string) => void
  contextEmptyLabel?: string
  contextErrorLabel?: string
  contextLoadingLabel?: string
  contextPickerLabel?: string
  contextRemoveLabel?: string
  capabilityScopeKey?: string
  getCapabilitySuggestions?: (query: string) => InlineCapabilitySuggestion[]
  onCapabilitySuggestionSelected?: (
    suggestion: InlineCapabilitySuggestion,
  ) => InlineContextSelection | string | null | Promise<InlineContextSelection | string | null>
  renderCapabilityPicker?: (props: {
    id: string
    items: InlineCapabilitySuggestion[]
    onHover: (index: number) => void
    onSelect: (index: number) => void
    selectedIndex: number
  }) => ReactNode
  serializeClipboardText?: (value: string) => string
  sanitizePastedText?: (value: string) => string
}

export interface InlineContextSelection {
  token: string
  commit: () => boolean
}

function collapseSelectionRange(nextSelectionIndex: number) {
  return {
    start: nextSelectionIndex,
    end: nextSelectionIndex,
  }
}

function fullSelectionRange(value: string) {
  return {
    start: 0,
    end: value.length,
  }
}

function isSelectAllShortcut(event: React.KeyboardEvent<HTMLDivElement>) {
  return event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey)
}

function isCommandBackspaceShortcut(event: React.KeyboardEvent<HTMLDivElement>) {
  return event.key === 'Backspace'
    && event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
}

function isLineBreakShortcut(
  event: React.KeyboardEvent<HTMLDivElement>,
  isComposing: boolean,
) {
  return event.key === 'Enter'
    && (event.shiftKey || event.ctrlKey)
    && !isComposing
    && !event.nativeEvent.isComposing
    && event.keyCode !== 229
}

function isNativeCompositionBeforeInput(
  nativeEvent: InputEvent,
  isComposing: boolean,
  hasPendingCompositionInput: boolean,
) {
  return isComposing
    || hasPendingCompositionInput
    || nativeEvent.isComposing
    || nativeEvent.inputType === 'insertCompositionText'
}

export const UNSUPPORTED_INLINE_PASTE_MESSAGE = 'Only text paste is supported in the AI composer right now.'

function hasUnsupportedClipboardPayload(clipboardData: DataTransfer) {
  if (clipboardData.files.length > 0) return true

  return Array.from(clipboardData.items).some((item) =>
    item.kind === 'file' || item.type.startsWith('image/'),
  )
}

function containsUnsupportedInlineContent(editor: HTMLDivElement) {
  return editor.querySelector('img, picture, video, audio, canvas, figure, iframe, object') !== null
}

function deleteToLineStart(
  value: string,
  selection: InlineSelectionRange,
): { value: string; selection: InlineSelectionRange } | null {
  const start = Math.max(0, Math.min(selection.start, selection.end, value.length))
  const end = Math.max(start, Math.min(Math.max(selection.start, selection.end), value.length))
  if (start !== end) return replaceInlineSelection(value, { start, end }, '')

  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  if (lineStart === start) return null

  return replaceInlineSelection(value, { start: lineStart, end: start }, '')
}

function submitInlineValue({
  onSubmit,
  submitOnEmpty,
  value,
  references,
}: {
  onSubmit?: (text: string, references: NoteReference[]) => void
  submitOnEmpty: boolean
  value: string
  references: NoteReference[]
}) {
  if (!onSubmit) return
  const normalizedValue = normalizeInlineWikilinkValue(value)
  if (!submitOnEmpty && !normalizedValue.trim()) return
  onSubmit(normalizedValue, references)
}

function renderInlineSuggestionList({
  suggestions,
  selectedSuggestionIndex,
  setSuggestionIndex,
  selectSuggestion,
  typeEntryMap,
  suggestionListVariant,
  suggestionEmptyLabel,
}: {
  suggestions: ReturnType<typeof useInlineWikilinkSuggestionsState>['suggestions']
  selectedSuggestionIndex: number
  setSuggestionIndex: (index: number) => void
  selectSuggestion: (index: number) => void
  typeEntryMap: Record<string, VaultEntry>
  suggestionListVariant: 'floating' | 'palette'
  suggestionEmptyLabel: string
}) {
  if (suggestions.length === 0) return null

  return (
    <InlineWikilinkSuggestionList
      suggestions={suggestions}
      selectedIndex={selectedSuggestionIndex}
      onHover={setSuggestionIndex}
      onSelect={selectSuggestion}
      typeEntryMap={typeEntryMap}
      variant={suggestionListVariant}
      emptyLabel={suggestionEmptyLabel}
    />
  )
}

export function InlineWikilinkInput({
  entries,
  value,
  onChange,
  onSubmit,
  onUnsupportedPaste,
  submitOnEmpty = false,
  disabled = false,
  placeholder,
  placeholderClassName,
  inputRef,
  dataTestId = 'agent-input',
  editorClassName,
  editorStyle,
  suggestionListVariant = 'floating',
  suggestionEmptyLabel = 'No matching notes',
  paletteHeader,
  paletteEmptyState,
  paletteFooter,
  contextReferences = [],
  contextScopeKey = '',
  loadContextSuggestions,
  onContextSuggestionSelected,
  onRemoveContext,
  contextEmptyLabel = 'No matching files or folders',
  contextErrorLabel = 'Could not load project context',
  contextLoadingLabel = 'Loading',
  contextPickerLabel = 'Add context',
  contextRemoveLabel = 'Remove context',
  capabilityScopeKey = '',
  getCapabilitySuggestions,
  onCapabilitySuggestionSelected,
  renderCapabilityPicker,
  serializeClipboardText = (text) => text,
  sanitizePastedText = (text) => text,
}: InlineWikilinkInputProps) {
  const latestValueRef = useRef(value)
  latestValueRef.current = value
  const contextSelectionRequestRef = useRef(0)
  const capabilitySelectionRequestRef = useRef(0)
  const [renderVersion, forceRender] = useState(0)
  const isComposingRef = useRef(false)
  const segments = useMemo(
    () => buildInlineWikilinkSegments(value, entries),
    [entries, value],
  )
  const typeEntryMap = useMemo(() => buildTypeEntryMap(entries), [entries])
  const {
    editorRef,
    selectionRange,
    selectionIndex,
    setSelectionRange,
    setCombinedRef,
    syncSelectionRange,
    focusSelectionRange,
  } = useInlineWikilinkSelection({
    value,
    onChange,
    inputRef,
    isComposingRef,
  })
  const pendingPasteRef = useRef<PendingPasteState | null>(null)
  const pendingCompositionInputRef = useRef(false)
  const handledFileDropRef = useRef(false)
  const pendingFocusAfterRemountRef = useRef<InlineSelectionRange | null>(null)
  const pendingScrollTopAfterRemountRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    void renderVersion
    restorePendingRemountState(
      editorRef.current,
      focusSelectionRange,
      pendingFocusAfterRemountRef,
      pendingScrollTopAfterRemountRef,
    )
  }, [editorRef, focusSelectionRange, renderVersion])
  const activeQuery = useMemo(
    () => selectionRange.start === selectionRange.end
      ? findActiveWikilinkQuery(value, selectionIndex)
      : null,
    [selectionIndex, selectionRange.end, selectionRange.start, value],
  )
  const activeContextQuery = useMemo(
    () => !activeQuery && selectionRange.start === selectionRange.end
      ? findActiveComposerContextQuery(value, selectionIndex)
      : null,
    [activeQuery, selectionIndex, selectionRange.end, selectionRange.start, value],
  )
  const activeCapabilityQuery = useMemo(
    () => !activeQuery && !activeContextQuery && selectionRange.start === selectionRange.end
      ? findActiveComposerCapabilityQuery(value, selectionIndex)
      : null,
    [activeContextQuery, activeQuery, selectionIndex, selectionRange.end, selectionRange.start, value],
  )
  const contextQueryKey = activeContextQuery
    ? `${contextScopeKey}:${activeContextQuery.start}:${activeContextQuery.query}`
    : ''
  const [contextPage, setContextPage] = useState<{
    error: boolean
    key: string
    loading: boolean
    suggestions: InlineContextSuggestion[]
  }>({ error: false, key: '', loading: false, suggestions: [] })
  const [contextSelection, setContextSelection] = useState({ key: '', index: 0 })
  const [dismissedContextKey, setDismissedContextKey] = useState('')
  const contextRequestIdRef = useRef(0)
  const contextFocusTimerRef = useRef<number | null>(null)
  const contextListboxId = useId()
  const capabilityQueryKey = activeCapabilityQuery
    ? `${capabilityScopeKey}:${activeCapabilityQuery.start}:${activeCapabilityQuery.query}`
    : ''
  const capabilitySuggestions = useMemo(
    () => activeCapabilityQuery && getCapabilitySuggestions
      ? getCapabilitySuggestions(activeCapabilityQuery.query)
      : [],
    [activeCapabilityQuery, getCapabilitySuggestions],
  )
  const [capabilitySelection, setCapabilitySelection] = useState({ key: '', index: 0 })
  const [dismissedCapabilityKey, setDismissedCapabilityKey] = useState('')
  const capabilityListboxId = useId()
  useEffect(() => {
    const requestId = ++contextRequestIdRef.current
    const controller = new AbortController()
    if (!activeContextQuery || !loadContextSuggestions || dismissedContextKey === contextQueryKey) {
      return () => controller.abort()
    }
    setContextPage({ error: false, key: contextQueryKey, loading: true, suggestions: [] })
    const timeout = window.setTimeout(() => {
      void loadContextSuggestions(activeContextQuery.query, controller.signal).then((suggestions) => {
        if (controller.signal.aborted || requestId !== contextRequestIdRef.current) return
        setContextPage({ error: false, key: contextQueryKey, loading: false, suggestions })
      }).catch(() => {
        if (controller.signal.aborted || requestId !== contextRequestIdRef.current) return
        setContextPage({ error: true, key: contextQueryKey, loading: false, suggestions: [] })
      })
    }, activeContextQuery.query ? 100 : 0)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
      if (contextRequestIdRef.current === requestId) contextRequestIdRef.current += 1
    }
  }, [
    activeContextQuery,
    contextQueryKey,
    dismissedContextKey,
    loadContextSuggestions,
  ])
  useEffect(() => {
    setContextPage({ error: false, key: '', loading: false, suggestions: [] })
    setContextSelection({ key: '', index: 0 })
    setDismissedContextKey('')
    return () => {
      if (contextFocusTimerRef.current !== null) {
        window.clearTimeout(contextFocusTimerRef.current)
        contextFocusTimerRef.current = null
      }
    }
  }, [contextScopeKey])
  useEffect(() => {
    setCapabilitySelection({ key: '', index: 0 })
    setDismissedCapabilityKey('')
  }, [capabilityScopeKey])
  const contextSuggestions = contextPage.key === contextQueryKey ? contextPage.suggestions : []
  const selectedContextIndex = contextSelection.key === contextQueryKey
    ? Math.min(contextSelection.index, Math.max(contextSuggestions.length - 1, 0))
    : 0
  const contextMenuOpen = Boolean(
    activeContextQuery
    && loadContextSuggestions
    && dismissedContextKey !== contextQueryKey,
  )
  const enabledCapabilityIndexes = capabilitySuggestions.flatMap((item, index) => (
    item.enabled ? [index] : []
  ))
  const selectedCapabilityIndex = capabilitySelection.key === capabilityQueryKey
    && capabilitySuggestions[capabilitySelection.index]?.enabled
    ? capabilitySelection.index
    : enabledCapabilityIndexes[0] ?? 0
  const capabilityMenuOpen = Boolean(
    activeCapabilityQuery
    && getCapabilitySuggestions
    && renderCapabilityPicker
    && dismissedCapabilityKey !== capabilityQueryKey,
  )
  const references = useMemo(() => extractInlineWikilinkReferences(value, entries), [entries, value])
  const {
    suggestions,
    selectedSuggestionIndex,
    setSuggestionIndex,
    selectSuggestion,
    cycleSuggestions,
  } = useInlineWikilinkSuggestionsState({
    activeQueryKey: activeQuery ? `${activeQuery.start}:${activeQuery.query}` : '',
    entries,
    query: activeQuery?.query ?? null,
    value,
    selectionIndex,
    onChange,
    onSelectionIndexChange: (nextSelectionIndex) => setSelectionRange(collapseSelectionRange(nextSelectionIndex)),
    focusSelectionAt: (nextSelectionIndex) => focusSelectionRange(collapseSelectionRange(nextSelectionIndex)),
  })
  const insertTransferText = useCallback((text: string, focusAfterInsert = false) => {
    const editor = editorRef.current
    const currentSelectionRange = editor && !focusAfterInsert
      ? readSelectionRange(editor)
      : selectionRange
    const nextState = replaceInlineSelection(value, currentSelectionRange, text)
    const shouldRestoreFocus = focusAfterInsert || document.activeElement === editor

    onChange(nextState.value)
    setSelectionRange(nextState.selection)
    pendingFocusAfterRemountRef.current = shouldRestoreFocus ? nextState.selection : null
    pendingScrollTopAfterRemountRef.current = editor?.scrollTop ?? null
    forceRender((current) => current + 1)
  }, [editorRef, onChange, selectionRange, setSelectionRange, value])
  const notifyUnsupportedPaste = useCallback(
    () => onUnsupportedPaste?.(UNSUPPORTED_INLINE_PASTE_MESSAGE),
    [onUnsupportedPaste],
  )
  const recoverUnsupportedMutation = () => {
    pendingCompositionInputRef.current = false
    pendingPasteRef.current = null
    notifyUnsupportedPaste()
    forceRender((current) => current + 1)
    setSelectionRange({ ...selectionRange })
  }
  const deleteContent = (direction: 'backward' | 'forward') => {
    const nextState = deleteInlineSelection(value, selectionRange, segments, direction)
    if (!nextState) return
    onChange(nextState.value)
    setSelectionRange(nextState.selection)
  }
  const deleteContentToLineStart = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isCommandBackspaceShortcut(event)) return false
    if (isComposingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return false

    const editor = editorRef.current
    const currentSelectionRange = editor ? readSelectionRange(editor) : selectionRange
    const nextState = deleteToLineStart(value, currentSelectionRange)

    event.preventDefault()
    event.stopPropagation()

    if (!nextState) return true

    onChange(nextState.value)
    setSelectionRange(nextState.selection)
    pendingFocusAfterRemountRef.current = nextState.selection
    forceRender((current) => current + 1)
    return true
  }
  const selectAllContent = () => {
    const nextSelection = fullSelectionRange(value)
    setSelectionRange(nextSelection)
    focusSelectionRange(nextSelection)
  }
  const cutSelectedContent = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return

    const editor = editorRef.current
    const currentSelectionRange = editor ? readSelectionRange(editor) : selectionRange
    const selectedText = selectedInlineText(value, currentSelectionRange)
    if (!selectedText) return

    event.preventDefault()
    event.clipboardData.setData(
      'text/plain',
      serializeClipboardText(normalizeInlineWikilinkValue(selectedText)),
    )

    const nextState = deleteInlineSelection(value, currentSelectionRange, segments, 'backward')
    if (!nextState) return

    onChange(nextState.value)
    setSelectionRange(nextState.selection)
    pendingFocusAfterRemountRef.current = nextState.selection
    forceRender((current) => current + 1)
  }
  const copySelectedContent = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    const currentSelectionRange = editor ? readSelectionRange(editor) : selectionRange
    const selectedText = selectedInlineText(value, currentSelectionRange)
    if (!selectedText) return
    event.preventDefault()
    event.clipboardData.setData(
      'text/plain',
      serializeClipboardText(normalizeInlineWikilinkValue(selectedText)),
    )
  }
  const handleBeforeInput = useCallback((nativeEvent: InputEvent) => {
    if (disabled) return

    if (!isInsertBeforeInput(nativeEvent)) return

    if (isNativeCompositionBeforeInput(
      nativeEvent,
      isComposingRef.current,
      pendingCompositionInputRef.current,
    )) return

    if (nativeEvent.inputType === 'insertLineBreak') {
      nativeEvent.preventDefault()
      insertTransferText('\n')
      return
    }

    if (isPlainTextBeforeInput(nativeEvent)) {
      nativeEvent.preventDefault()
      insertTransferText(nativeEvent.data)
      return
    }

    const dataTransfer = nativeEvent.dataTransfer
    if (!dataTransfer || !hasUnsupportedClipboardPayload(dataTransfer)) return

    if (nativeEvent.inputType === 'insertFromDrop' && handledFileDropRef.current) {
      handledFileDropRef.current = false
      nativeEvent.preventDefault()
      return
    }

    if (nativeEvent.inputType === 'insertFromDrop') {
      const droppedPathText = extractDroppedPathText(dataTransfer)
      if (droppedPathText) {
        nativeEvent.preventDefault()
        insertTransferText(droppedPathText)
        return
      }
    }

    nativeEvent.preventDefault()
    notifyUnsupportedPaste()
  }, [disabled, insertTransferText, notifyUnsupportedPaste])
  useLayoutEffect(() => {
    void renderVersion
    const editor = editorRef.current
    if (!editor) return

    editor.addEventListener('beforeinput', handleBeforeInput as EventListener)
    return () => editor.removeEventListener('beforeinput', handleBeforeInput as EventListener)
  }, [editorRef, handleBeforeInput, renderVersion])
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return
    if (!hasUnsupportedClipboardPayload(event.dataTransfer)) return

    handledFileDropRef.current = true
    const droppedPathText = extractDroppedPathText(event.dataTransfer)
    event.preventDefault()

    if (!droppedPathText) {
      notifyUnsupportedPaste()
      return
    }

    insertTransferText(droppedPathText)
  }
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return

    if (hasUnsupportedClipboardPayload(event.clipboardData)) {
      event.preventDefault()
      notifyUnsupportedPaste()
      return
    }

    const pastedText = sanitizePastedText(normalizeInlineWikilinkValue(
      event.clipboardData.getData('text/plain'),
    ))
    if (!pastedText) return

    const nextState = replaceInlineSelection(value, selectionRange, pastedText)
    pendingPasteRef.current = buildPendingPasteState(value, selectionRange, pastedText)

    event.preventDefault()
    onChange(nextState.value)
    setSelectionRange(nextState.selection)
  }
  const syncValueFromEditor = () => {
    const editor = editorRef.current
    if (editor && containsUnsupportedInlineContent(editor)) {
      recoverUnsupportedMutation()
      return
    }

    const pendingPaste = pendingPasteRef.current
    if (editor && pendingPaste) {
      const nextValue = normalizeInlineWikilinkValue(serializeInlineNode(editor))
      pendingPasteRef.current = null

      if (shouldRecoverPendingPaste(nextValue, pendingPaste)) {
        onChange(pendingPaste.expectedValue)
        forceRender((current) => current + 1)
        setSelectionRange({ ...pendingPaste.expectedSelection })
        return
      }
    }

    if (!editor) return

    const nextValue = normalizeInlineWikilinkValue(serializeInlineNode(editor))
    const nextSelection = readSelectionRange(editor)
    const clampedSelection: InlineSelectionRange = {
      start: Math.min(nextSelection.start, nextValue.length),
      end: Math.min(nextSelection.end, nextValue.length),
    }

    const shouldRestoreFocus = document.activeElement === editor
    pendingFocusAfterRemountRef.current = shouldRestoreFocus ? clampedSelection : null
    onChange(nextValue)
    setSelectionRange(clampedSelection)
    forceRender((current) => current + 1)
  }
  const flushPendingCompositionInput = (compositionEditor?: HTMLDivElement | null) => {
    if (isComposingRef.current) return
    const hadPendingInput = pendingCompositionInputRef.current
    pendingCompositionInputRef.current = false

    const editor = compositionEditor ?? editorRef.current
    if (!editor) return

    if (containsUnsupportedInlineContent(editor)) {
      recoverUnsupportedMutation()
      return
    }

    const nextValue = normalizeInlineWikilinkValue(serializeInlineNode(editor))
    if (!hadPendingInput && nextValue === value) return

    const nextSelection = readSelectionRange(editor)
    const clampedSelection: InlineSelectionRange = {
      start: Math.min(nextSelection.start, nextValue.length),
      end: Math.min(nextSelection.end, nextValue.length),
    }

    const shouldRestoreFocus = document.activeElement === editor || document.activeElement === editorRef.current
    pendingFocusAfterRemountRef.current = shouldRestoreFocus ? clampedSelection : null
    onChange(nextValue)
    setSelectionRange(clampedSelection)
    forceRender((current) => current + 1)
  }
  const handleCompositionStart = () => {
    isComposingRef.current = true
  }
  const handleCompositionUpdate = () => {
    isComposingRef.current = true
  }
  const handleCompositionEnd = (compositionEditor: HTMLDivElement) => {
    isComposingRef.current = false
    queueMicrotask(() => flushPendingCompositionInput(compositionEditor))
  }
  const handleInput = () => {
    if (disabled) return

    if (isComposingRef.current) {
      pendingCompositionInputRef.current = true
      return
    }

    pendingCompositionInputRef.current = false
    syncValueFromEditor()
  }
  const submitValue = () => {
    const currentValue = editorRef.current
      ? normalizeInlineWikilinkValue(serializeInlineNode(editorRef.current))
      : value
    const currentReferences = currentValue === value
      ? references
      : extractInlineWikilinkReferences(currentValue, entries)

    submitInlineValue({
      onSubmit,
      submitOnEmpty,
      value: currentValue,
      references: currentReferences,
    })
  }
  const selectContextSuggestion = async (index: number) => {
    const suggestion = contextSuggestions.at(index)
    if (!suggestion || !onContextSuggestionSelected) return
    const selectedValue = value
    const selectedIndex = selectionIndex
    const request = ++contextSelectionRequestRef.current
    const selection = await onContextSuggestionSelected(suggestion)
    if (request !== contextSelectionRequestRef.current
      || latestValueRef.current !== selectedValue) return
    if (!selection) return
    const token = typeof selection === 'string' ? selection : selection.token
    const replacement = replaceActiveComposerContextQuery(selectedValue, selectedIndex, token)
    if (!replacement) return
    if (typeof selection !== 'string' && !selection.commit()) return
    onChange(replacement.value)
    setSelectionRange(collapseSelectionRange(replacement.nextSelectionIndex))
    setContextSelection({ key: '', index: 0 })
    setDismissedContextKey('')
    if (contextFocusTimerRef.current !== null) window.clearTimeout(contextFocusTimerRef.current)
    contextFocusTimerRef.current = window.setTimeout(() => {
      contextFocusTimerRef.current = null
      focusSelectionRange(collapseSelectionRange(replacement.nextSelectionIndex))
    }, 0)
  }
  const selectCapabilitySuggestion = async (index: number) => {
    const suggestion = capabilitySuggestions.at(index)
    if (!suggestion?.enabled || !onCapabilitySuggestionSelected) return
    const selectedValue = value
    const selectedIndex = selectionIndex
    const request = ++capabilitySelectionRequestRef.current
    const selection = await onCapabilitySuggestionSelected(suggestion)
    if (request !== capabilitySelectionRequestRef.current
      || latestValueRef.current !== selectedValue) return
    if (!selection) return
    const token = typeof selection === 'string' ? selection : selection.token
    const replacement = replaceActiveComposerCapabilityQuery(selectedValue, selectedIndex, token)
    if (!replacement) return
    if (typeof selection !== 'string' && !selection.commit()) return
    onChange(replacement.value)
    const nextSelection = collapseSelectionRange(replacement.nextSelectionIndex)
    setSelectionRange(nextSelection)
    setCapabilitySelection({ key: '', index: 0 })
    setDismissedCapabilityKey('')
    window.setTimeout(() => focusSelectionRange(nextSelection), 0)
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!disabled && isLineBreakShortcut(event, isComposingRef.current)) {
      event.preventDefault()
      insertTransferText('\n')
      return
    }

    if (isSelectAllShortcut(event)) {
      event.preventDefault()
      selectAllContent()
      return
    }

    if (!disabled && deleteContentToLineStart(event)) {
      return
    }

    const compositionEvent = isComposingRef.current
      || event.nativeEvent.isComposing
      || event.key === 'Process'
      || event.keyCode === 229
    if (!disabled && contextMenuOpen && !compositionEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedContextKey(contextQueryKey)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const count = contextSuggestions.length
        if (count > 0) {
          const current = contextSelection.key === contextQueryKey ? contextSelection.index : 0
          setContextSelection({
            key: contextQueryKey,
            index: (current + direction + count) % count,
          })
        }
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && contextSuggestions.length > 0) {
        event.preventDefault()
        void selectContextSuggestion(selectedContextIndex)
        return
      }
    }
    if (!disabled && capabilityMenuOpen && !compositionEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedCapabilityKey(capabilityQueryKey)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (enabledCapabilityIndexes.length > 0) {
          const currentPosition = Math.max(
            0,
            enabledCapabilityIndexes.indexOf(selectedCapabilityIndex),
          )
          const direction = event.key === 'ArrowDown' ? 1 : -1
          const nextPosition = (
            currentPosition + direction + enabledCapabilityIndexes.length
          ) % enabledCapabilityIndexes.length
          setCapabilitySelection({
            key: capabilityQueryKey,
            index: enabledCapabilityIndexes[nextPosition],
          })
        }
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab')
        && capabilitySuggestions[selectedCapabilityIndex]?.enabled) {
        event.preventDefault()
        void selectCapabilitySuggestion(selectedCapabilityIndex)
        return
      }
    }

    handleInlineWikilinkKeyDown({
      event,
      disabled,
      isComposing: isComposingRef.current,
      suggestionsOpen: suggestions.length > 0,
      onCycleSuggestions: cycleSuggestions,
      onSelectSuggestion: () => selectSuggestion(selectedSuggestionIndex),
      onDeleteContent: deleteContent,
      canSubmit: onSubmit !== undefined,
      onSubmit: submitValue,
    })
  }
  const editor = (
    <InlineWikilinkEditorField
      key={renderVersion}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      inputRef={setCombinedRef}
      dataTestId={dataTestId}
      placeholderClassName={placeholderClassName}
      editorClassName={editorClassName}
      editorStyle={editorStyle}
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      onCompositionUpdate={handleCompositionUpdate}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onCut={cutSelectedContent}
      onCopy={copySelectedContent}
      onDrop={handleDrop}
      onPaste={handlePaste}
      onSelectionChange={syncSelectionRange}
      segments={segments}
      contextActiveDescendantId={contextMenuOpen && contextSuggestions.length > 0
        ? `${contextListboxId}-option-${selectedContextIndex}`
        : capabilityMenuOpen && capabilitySuggestions[selectedCapabilityIndex]?.enabled
          ? `${capabilityListboxId}-option-${selectedCapabilityIndex}`
          : undefined}
      contextListboxId={contextMenuOpen
        ? contextListboxId
        : capabilityMenuOpen ? capabilityListboxId : undefined}
      contextReferences={contextReferences}
      contextRemoveLabel={contextRemoveLabel}
      onRemoveContext={onRemoveContext}
      typeEntryMap={typeEntryMap}
    />
  )
  const suggestionList = renderInlineSuggestionList({
    suggestions,
    selectedSuggestionIndex,
    setSuggestionIndex,
    selectSuggestion,
    typeEntryMap,
    suggestionListVariant,
    suggestionEmptyLabel,
  })
  if (suggestionListVariant === 'palette') {
    return (
      <InlineWikilinkPaletteLayout
        header={paletteHeader}
        editor={editor}
        suggestionList={suggestionList}
        emptyState={paletteEmptyState}
        footer={paletteFooter}
      />
    )
  }
  const contextSuggestionList = contextMenuOpen ? (
    <InlineContextSuggestionList
      id={contextListboxId}
      label={contextPickerLabel}
      emptyLabel={contextEmptyLabel}
      errorLabel={contextPage.key === contextQueryKey && contextPage.error
        ? contextErrorLabel
        : undefined}
      loading={contextPage.key !== contextQueryKey || contextPage.loading}
      loadingLabel={contextLoadingLabel}
      onHover={(index) => setContextSelection({ key: contextQueryKey, index })}
      onSelect={(index) => void selectContextSuggestion(index)}
      selectedIndex={selectedContextIndex}
      suggestions={contextSuggestions}
    />
  ) : null
  const capabilitySuggestionList = capabilityMenuOpen ? renderCapabilityPicker?.({
    id: capabilityListboxId,
    items: capabilitySuggestions,
    onHover: (index) => capabilitySuggestions[index]?.enabled
      && setCapabilitySelection({ key: capabilityQueryKey, index }),
    onSelect: (index) => void selectCapabilitySuggestion(index),
    selectedIndex: selectedCapabilityIndex,
  }) : null
  return (
    <div className="relative">
      {editor}
      {contextSuggestionList ?? capabilitySuggestionList ?? suggestionList}
    </div>
  )
}
