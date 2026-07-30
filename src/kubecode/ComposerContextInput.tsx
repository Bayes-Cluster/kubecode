import { useCallback, useEffect, useMemo, useRef } from 'react'

import { InlineWikilinkInput } from '@/components/InlineWikilinkInput'
import type { InlineContextReference, InlineContextSuggestion } from '@/components/inlineContext'
import type { InlineCapabilitySuggestion } from '@/components/inlineContext'
import type { VaultEntry } from '@/types'

import type { ComposerCatalogSnapshot, GitDiffContextCandidate, KubecodeApi } from './api'
import { ComposerCapabilityPicker, type ComposerCapabilityPickerLabels } from './ComposerCapabilityPicker'
import { rankComposerCapabilities } from './composerCapabilities'
import {
  composerDraftFromEditorValue,
  composerDraftAllReferences,
  composerDraftPlainText,
  composerDraftReferences,
  composerDraftToEditorValue,
  createComposerContextReference,
  createComposerCapabilityReference,
  applyComposerContextValidation,
  MAX_COMPOSER_CONTEXT_REFERENCES,
  type ComposerDraft,
} from './composerDraft'
import { searchSessionEntries } from './projectPathSearch'

type ComposerContextInputProps = {
  api: KubecodeApi
  capabilityCatalog?: ComposerCatalogSnapshot
  capabilityLabels: ComposerCapabilityPickerLabels
  capabilityStatus: 'error' | 'loading' | 'ready'
  contextEmptyLabel: string
  contextErrorLabel: string
  contextLoadingLabel: string
  contextPickerLabel: string
  contextRemoveLabel: string
  gitDiffLabels: {
    all: string
    disabled: (reason: string | null) => string
    summary: (candidate: GitDiffContextCandidate) => string
  }
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
  capabilityCatalog,
  capabilityLabels,
  capabilityStatus,
  contextEmptyLabel,
  contextErrorLabel,
  contextLoadingLabel,
  contextPickerLabel,
  contextRemoveLabel,
  gitDiffLabels,
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
      itemKind: reference.itemKind,
      kind: 'capability',
      name: reference.name,
      path: `$${reference.name}`,
      scope: reference.scope,
      scopeLabel: reference.scope ? capabilityLabels.scope[reference.scope] : undefined,
      sourceLabel: reference.sourceLabel,
    }
  )), [capabilityLabels.scope, references])
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
      context_kind: 'file' | 'directory' | 'git_diff' | 'terminal'
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
  ): Promise<InlineContextSuggestion[]> => {
    const [entries, gitDiffs] = await Promise.all([
      searchSessionEntries({
        api,
        conversationId,
        maxEntries: 2_000,
        maxResults: 100,
        query,
        signal,
      }),
      typeof api.listComposerGitDiffs === 'function'
        ? api.listComposerGitDiffs(conversationId, signal).catch(() => ({
            is_repository: false,
            candidates: [],
          }))
        : Promise.resolve({ is_repository: false, candidates: [] }),
    ])
    const search = query.trim().toLocaleLowerCase()
    const diffSuggestions = gitDiffs.candidates
      .map((candidate): InlineContextSuggestion => {
        const path = candidate.path ?? 'git-diff'
        return {
          kind: 'git_diff',
          name: candidate.path?.split('/').at(-1) ?? gitDiffLabels.all,
          path,
          selector: candidate.path ?? '.',
          sourceRevision: candidate.source_revision,
          summary: {
            kind: 'git_diff',
            scope: candidate.path ? 'file' : 'all',
            file_count: candidate.file_count,
            hunk_count: candidate.hunk_count,
            byte_count: candidate.byte_count,
          },
          enabled: candidate.enabled,
          disabledReason: candidate.enabled ? null : gitDiffLabels.disabled(candidate.disabled_reason),
          description: gitDiffLabels.summary(candidate),
        }
      })
      .filter((suggestion) => !search || [suggestion.name, suggestion.path, suggestion.description]
        .some((value) => value?.toLocaleLowerCase().includes(search)))
    return [...entries, ...diffSuggestions]
  }, [api, conversationId, gitDiffLabels])

  const selectContextSuggestion = useCallback(async (suggestion: InlineContextSuggestion) => {
    if (referencesRef.current.length >= MAX_COMPOSER_CONTEXT_REFERENCES) return null
    const generation = generationRef.current
    pendingRegistrationsRef.current += 1
    onPendingChange?.(true)
    try {
      const registration = await api.registerComposerContext(conversationId, {
        kind: suggestion.kind,
        path: suggestion.selector ?? suggestion.path,
        source_revision: suggestion.sourceRevision,
      })
      if (generation !== generationRef.current
        || registration.context.kind !== suggestion.kind
        || !registration.context.enabled) return null
      const displayPath = suggestion.kind === 'git_diff'
        ? suggestion.path
        : registration.context.display
      if (suggestion.kind !== 'git_diff' && displayPath !== suggestion.path) return null
      const reference = createComposerContextReference({
        catalogRevision: registration.catalog.revision,
        id: registration.context.id,
        kind: registration.context.kind,
        name: suggestion.name,
        path: displayPath,
        summary: registration.context.summary,
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

  const getCapabilitySuggestions = useCallback((query: string): InlineCapabilitySuggestion[] => (
    rankComposerCapabilities(capabilityCatalog, query).map((item) => ({
      catalogRevision: item.catalogRevision,
      description: item.description,
      disabledReason: item.disabled_reason,
      enabled: item.enabled,
      id: item.id,
      itemKind: item.kind,
      name: item.name,
      scope: item.scope,
      sourceLabel: item.source_label,
    }))
  ), [capabilityCatalog])

  const selectCapabilitySuggestion = useCallback((suggestion: InlineCapabilitySuggestion) => {
    if (!capabilityCatalog
      || capabilityCatalog.revision !== suggestion.catalogRevision
      || referencesRef.current.length >= MAX_COMPOSER_CONTEXT_REFERENCES) return null
    const item = capabilityCatalog.items.find((candidate) => (
      candidate.id === suggestion.id
      && candidate.kind === suggestion.itemKind
      && candidate.enabled
    ))
    if (!item) return null
    const reference = createComposerCapabilityReference({
      catalogRevision: capabilityCatalog.revision,
      id: item.id,
      itemKind: suggestion.itemKind,
      name: item.name,
      scope: item.scope,
      sourceLabel: item.source_label,
    })
    return {
      token: reference.id,
      commit: () => {
        if (referencesRef.current.length >= MAX_COMPOSER_CONTEXT_REFERENCES) return false
        referencesRef.current = [...referencesRef.current, reference]
        return true
      },
    }
  }, [capabilityCatalog])

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
    (text, reference) => text.replaceAll(
      `[[${reference.id}]]`,
      'path' in reference ? `@${reference.path}` : `$${reference.name}`,
    ),
    value,
  ), [])

  return (
    <div onKeyDownCapture={onKeyDownCapture}>
    <InlineWikilinkInput
      capabilityScopeKey={conversationId}
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
      getCapabilitySuggestions={getCapabilitySuggestions}
      onCapabilitySuggestionSelected={selectCapabilitySuggestion}
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
      renderCapabilityPicker={({ id, items, onHover, onSelect, selectedIndex }) => (
        <ComposerCapabilityPicker
          id={id}
          items={items.map((item) => ({
            catalogRevision: item.catalogRevision,
            description: item.description,
            disabled_reason: item.disabledReason,
            enabled: item.enabled,
            id: item.id,
            input_hint: null,
            kind: item.itemKind,
            name: item.name,
            scope: item.scope,
            source_label: item.sourceLabel,
          }))}
          labels={capabilityLabels}
          onHover={onHover}
          onSelect={onSelect}
          selectedIndex={selectedIndex}
          status={capabilityStatus}
        />
      )}
      value={editorValue}
    />
    </div>
  )
}
