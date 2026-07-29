import { useCallback, useEffect, useMemo, useRef } from 'react'

import { InlineWikilinkInput } from '@/components/InlineWikilinkInput'
import type { InlineContextReference, InlineContextSuggestion } from '@/components/inlineContext'
import type { VaultEntry } from '@/types'

import type { ComposerCatalogSnapshot, KubecodeApi } from './api'
import {
  composerDraftFromEditorValue,
  composerDraftAllReferences,
  composerDraftPlainText,
  composerDraftReferences,
  composerDraftToEditorValue,
  createComposerContextReference,
  applyComposerContextValidation,
  MAX_COMPOSER_CONTEXT_REFERENCES,
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
  onCatalogChange?: (catalog: ComposerCatalogSnapshot) => void
  onPendingChange?: (pending: boolean) => void
  onRegistrationError?: (cause: unknown) => void
  onKeyDownCapture?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onSubmit: (plainText: string) => void
  placeholder: string
  submitDisabled?: boolean
}

function contextVaultEntry(reference: InlineContextReference): VaultEntry {
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
  onCatalogChange,
  onPendingChange,
  onRegistrationError,
  onKeyDownCapture,
  onSubmit,
  placeholder,
  submitDisabled = false,
}: ComposerContextInputProps) {
  const contextReferences = useMemo(() => composerDraftReferences(draft), [draft])
  const references = useMemo(() => composerDraftAllReferences(draft), [draft])
  const inlineReferences = useMemo<InlineContextReference[]>(() => references.map((reference) => (
    'path' in reference ? reference : {
      availability: reference.availability,
      id: reference.id,
      kind: 'capability',
      name: reference.name,
      path: `$${reference.name}`,
    }
  )), [references])
  const staleReferenceKey = useMemo(
    () => JSON.stringify(contextReferences
      .filter((reference) => reference.availability === 'stale')
      .map((reference) => ({
        id: reference.id,
        catalog_revision: reference.catalogRevision,
        context_kind: reference.kind,
      }))),
    [contextReferences],
  )
  const referencesRef = useRef(references)
  useEffect(() => {
    referencesRef.current = references
  }, [references])
  const editorValue = useMemo(() => composerDraftToEditorValue(draft), [draft])
  const entries = useMemo(() => inlineReferences.map(contextVaultEntry), [inlineReferences])
  const generationRef = useRef(0)
  const pendingRegistrationsRef = useRef(0)

  useEffect(() => {
    generationRef.current += 1
    pendingRegistrationsRef.current = 0
    onPendingChange?.(false)
    return () => {
      generationRef.current += 1
      pendingRegistrationsRef.current = 0
      onPendingChange?.(false)
    }
  }, [conversationId, onPendingChange])

  useEffect(() => {
    const referenceRecords = JSON.parse(staleReferenceKey) as Array<{
      id: string
      catalog_revision: number
      context_kind: 'file' | 'directory'
    }>
    if (referenceRecords.length === 0) return
    let current = true
    void api.validateComposerContexts(conversationId, referenceRecords)
      .then((response) => {
        if (!current) return
        onCatalogChange?.(response.catalog)
        onChange((currentDraft) => applyComposerContextValidation(currentDraft, response))
      })
      .catch(() => {
        // Hydration is already stale; endpoint failure must not promote refs.
      })
    return () => {
      current = false
    }
  }, [api, conversationId, onCatalogChange, onChange, staleReferenceKey])

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

  const selectContextSuggestion = useCallback(async (suggestion: InlineContextSuggestion) => {
    if (referencesRef.current.length >= MAX_COMPOSER_CONTEXT_REFERENCES) return null
    const generation = generationRef.current
    pendingRegistrationsRef.current += 1
    onPendingChange?.(true)
    try {
      const registration = await api.registerComposerContext(conversationId, {
        kind: suggestion.kind,
        path: suggestion.path,
      })
      if (generation !== generationRef.current
        || registration.context.kind !== suggestion.kind
        || registration.context.display !== suggestion.path
        || !registration.context.enabled) return null
      const reference = createComposerContextReference({
        catalogRevision: registration.catalog.revision,
        id: registration.context.id,
        kind: registration.context.kind,
        name: suggestion.name,
        path: registration.context.display,
      })
      return {
        token: reference.id,
        commit: () => {
          if (generation !== generationRef.current
            || referencesRef.current.length >= MAX_COMPOSER_CONTEXT_REFERENCES) return false
          referencesRef.current = [...referencesRef.current, reference]
          onCatalogChange?.(registration.catalog)
          return true
        },
      }
    } catch (cause) {
      if (generation === generationRef.current) onRegistrationError?.(cause)
      return null
    } finally {
      if (generation === generationRef.current) {
        pendingRegistrationsRef.current = Math.max(0, pendingRegistrationsRef.current - 1)
        onPendingChange?.(pendingRegistrationsRef.current > 0)
      }
    }
  }, [api, conversationId, onCatalogChange, onPendingChange, onRegistrationError])

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
  const sanitizePastedText = useCallback((value: string) => referencesRef.current.reduce(
    (text, reference) => text.replaceAll(`[[${reference.id}]]`, `@${reference.path ?? reference.name}`),
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
