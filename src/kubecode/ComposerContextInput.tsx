import { useCallback, useEffect, useMemo, useRef } from 'react'

import { InlineWikilinkInput } from '@/components/InlineWikilinkInput'
import type { InlineContextSuggestion } from '@/components/inlineContext'
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
  contextRemoveLabel: string
  conversationId: string
  disabled: boolean
  draft: ComposerDraft
  inputRef: React.RefObject<HTMLDivElement | null>
  onChange: (draft: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) => void
  onSubmit: (plainText: string) => void
  placeholder: string
  submitDisabled?: boolean
}

function contextVaultEntry(reference: ComposerContextReference): VaultEntry {
  return {
    aliases: [],
    archived: false,
    color: null,
    filename: reference.id,
    icon: null,
    isA: null,
    path: reference.id,
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
  contextRemoveLabel,
  conversationId,
  disabled,
  draft,
  inputRef,
  onChange,
  onSubmit,
  placeholder,
  submitDisabled = false,
}: ComposerContextInputProps) {
  const references = useMemo(() => composerDraftReferences(draft), [draft])
  const staleReferenceKey = useMemo(
    () => JSON.stringify(references
      .filter((reference) => reference.availability === 'stale')
      .map((reference) => ({
        id: reference.id,
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

  useEffect(() => {
    const referenceRecords = JSON.parse(staleReferenceKey) as Array<{
      id: string
      kind: 'file' | 'directory'
      parent: string
      path: string
    }>
    if (referenceRecords.length === 0) return
    let current = true
    const directories = [...new Set(referenceRecords.map((reference) => reference.parent))]
    void Promise.all(directories.map((directory) => api.listSessionEntries(conversationId, directory)))
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
    }
  }, [api, conversationId, onChange, staleReferenceKey])

  const loadContextSuggestions = useCallback(async (query: string): Promise<InlineContextSuggestion[]> => (
    searchSessionEntries({
      api,
      conversationId,
      maxEntries: 2_000,
      maxResults: 100,
      query,
    })
  ), [api, conversationId])

  const selectContextSuggestion = useCallback((suggestion: InlineContextSuggestion) => {
    if (referencesRef.current.length >= MAX_COMPOSER_CONTEXT_REFERENCES) return null
    const reference = createComposerContextReference(suggestion)
    referencesRef.current = [...referencesRef.current, reference]
    return reference.id
  }, [])

  const updateEditorValue = useCallback((value: string) => {
    onChange(composerDraftFromEditorValue(value, referencesRef.current))
  }, [onChange])

  const removeContext = useCallback((id: string) => {
    const marker = `[[${id}]]`
    const nextValue = editorValue.replace(marker, '')
    onChange(composerDraftFromEditorValue(
      nextValue,
      referencesRef.current.filter((reference) => reference.id !== id),
    ))
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [editorValue, inputRef, onChange])

  const clipboardText = useCallback((value: string) => composerDraftPlainText(
    composerDraftFromEditorValue(value, referencesRef.current),
  ), [])

  return (
    <InlineWikilinkInput
      contextEmptyLabel={contextEmptyLabel}
      contextErrorLabel={contextErrorLabel}
      contextLoadingLabel={contextLoadingLabel}
      contextReferences={references}
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
      value={editorValue}
    />
  )
}
