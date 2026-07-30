import { useCallback, useEffect, useMemo, useRef } from 'react'

import { InlineWikilinkInput } from '@/components/InlineWikilinkInput'
import type { InlineContextReference, InlineContextSuggestion } from '@/components/inlineContext'
import type { VaultEntry } from '@/types'

import type { KubecodeApi } from './api'
import {
  composerDraftFromEditorValue,
  composerDraftPlainText,
  composerDraftReferences,
  composerDraftToEditorValue,
  createComposerContextReference,
  applyComposerContextValidation,
  MAX_COMPOSER_CONTEXT_REFERENCES,
  type ComposerContextReference,
  type ComposerDraft,
} from './composerDraft'
import { searchSessionEntries } from './projectPathSearch'

type ComposerContextInputProps = {
  api: KubecodeApi
  contextEmptyLabel: string
  contextErrorLabel: string
  contextLoadingLabel: string
  contextPickerLabel: string
  contextRemoveLabel: string
  conversationId: string
  disabled: boolean
  draft: ComposerDraft
  inputRef: React.RefObject<HTMLDivElement | null>
  onChange: (draft: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) => void
  onKeyDownCapture?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onSubmit: (plainText: string) => void
  placeholder: string
  submitDisabled?: boolean
}

function contextVaultEntry(reference: ComposerContextReference): VaultEntry {
  return {
    aliases: [],
    archived: false,
    color: null,
    filename: reference.localKey,
    icon: null,
    isA: null,
    path: reference.localKey,
    title: reference.name,
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

export function ComposerContextInput({
  api,
  contextEmptyLabel,
  contextErrorLabel,
  contextLoadingLabel,
  contextPickerLabel,
  contextRemoveLabel,
  conversationId,
  disabled,
  draft,
  inputRef,
  onChange,
  onKeyDownCapture,
  onSubmit,
  placeholder,
  submitDisabled = false,
}: ComposerContextInputProps) {
  const references = useMemo(() => composerDraftReferences(draft), [draft])
  const staleReferenceKey = useMemo(
    () => JSON.stringify(references
      .filter((reference) => reference.availability === 'stale')
      .map((reference) => ({
        localKey: reference.localKey,
        kind: reference.kind,
        parent: parentPath(reference.path),
        path: reference.path,
      }))),
    [references],
  )
  const referencesRef = useRef(references)
  useEffect(() => {
    referencesRef.current = references
  }, [references])
  const editorValue = useMemo(() => composerDraftToEditorValue(draft), [draft])
  const entries = useMemo(() => references.map(contextVaultEntry), [references])
  const inlineReferences = useMemo<InlineContextReference[]>(() => references.map((reference) => ({
    ...reference,
    id: reference.localKey,
  })), [references])

  useEffect(() => {
    const referenceRecords = JSON.parse(staleReferenceKey) as Array<{
      localKey: string
      kind: 'file' | 'directory'
      parent: string
      path: string
    }>
    if (referenceRecords.length === 0) return
    let current = true
    const controller = new AbortController()
    const directories = [...new Set(referenceRecords.map((reference) => reference.parent))]
    void Promise.all(directories.map((directory) => (
      api.listSessionEntries(conversationId, directory, controller.signal)
    )))
      .then((pages) => {
        if (!current) return
        onChange((currentDraft) => applyComposerContextValidation(
          currentDraft,
          referenceRecords,
          pages.flat(),
        ))
      })
      .catch(() => {
        if (!current) return
        onChange((currentDraft) => applyComposerContextValidation(
          currentDraft,
          referenceRecords,
          [],
        ))
      })
    return () => {
      current = false
      controller.abort()
    }
  }, [api, conversationId, onChange, staleReferenceKey])

  const loadContextSuggestions = useCallback(async (
    query: string,
    signal: AbortSignal,
  ): Promise<InlineContextSuggestion[]> => (
    searchSessionEntries({
      api,
      conversationId,
      maxEntries: 2_000,
      maxResults: 100,
      query,
      signal,
    })
  ), [api, conversationId])

  const selectContextSuggestion = useCallback((suggestion: InlineContextSuggestion) => {
    if (referencesRef.current.length >= MAX_COMPOSER_CONTEXT_REFERENCES) return null
    const reference = createComposerContextReference(suggestion)
    referencesRef.current = [...referencesRef.current, reference]
    return reference.localKey
  }, [])

  const updateEditorValue = useCallback((value: string) => {
    onChange(composerDraftFromEditorValue(value, referencesRef.current))
  }, [onChange])

  const removeContext = useCallback((localKey: string) => {
    const marker = `[[${localKey}]]`
    const nextValue = editorValue.replace(marker, '')
    onChange(composerDraftFromEditorValue(
      nextValue,
      referencesRef.current.filter((reference) => reference.localKey !== localKey),
    ))
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [editorValue, inputRef, onChange])

  const clipboardText = useCallback((value: string) => composerDraftPlainText(
    composerDraftFromEditorValue(value, referencesRef.current),
  ), [])
  const sanitizePastedText = useCallback((value: string) => referencesRef.current.reduce(
    (text, reference) => text.replaceAll(`[[${reference.localKey}]]`, `@${reference.path}`),
    value,
  ), [])

  return (
    <div onKeyDownCapture={onKeyDownCapture}>
    <InlineWikilinkInput
      contextEmptyLabel={contextEmptyLabel}
      contextErrorLabel={contextErrorLabel}
      contextLoadingLabel={contextLoadingLabel}
      contextPickerLabel={contextPickerLabel}
      contextReferences={inlineReferences}
      contextScopeKey={conversationId}
      contextRemoveLabel={contextRemoveLabel}
      dataTestId="agent-input"
      disabled={disabled}
      editorClassName="kubecode-composer-editor min-h-[32px] max-h-[184px] overflow-y-auto overscroll-contain border-0 px-2 py-1.5 leading-5"
      editorStyle={{
        maxHeight: 184,
        minHeight: 32,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      }}
      entries={entries}
      inputRef={inputRef}
      loadContextSuggestions={loadContextSuggestions}
      onChange={updateEditorValue}
      onContextSuggestionSelected={selectContextSuggestion}
      onRemoveContext={removeContext}
      onSubmit={(value) => {
        if (!submitDisabled) onSubmit(clipboardText(value))
      }}
      placeholder={placeholder}
      placeholderClassName="kubecode-composer-placeholder px-2 py-1.5 leading-5"
      serializeClipboardText={clipboardText}
      sanitizePastedText={sanitizePastedText}
      value={editorValue}
    />
    </div>
  )
}
