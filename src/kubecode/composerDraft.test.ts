import { describe, expect, it } from 'vitest'

import {
  applyComposerContextValidation,
  applyComposerCatalogSnapshot,
  composerDraftCapabilityReferences,
  composerDraftFromEditorValue,
  composerDraftPlainText,
  composerDraftToEditorValue,
  composerDraftToStructuredSegments,
  appendComposerText,
  appendComposerContext,
  composerDraftReferences,
  MAX_COMPOSER_CONTEXT_REFERENCES,
  createComposerContextReference,
  parseStoredComposerDraft,
  serializeComposerDraft,
  textComposerDraft,
  type ComposerDraft,
} from './composerDraft'

const catalog = {
  conversation_id: 'session-1',
  revision: 7,
  items: [],
  contexts: [],
}

function context(overrides: Partial<Parameters<typeof createComposerContextReference>[0]> = {}) {
  return createComposerContextReference({
    catalogRevision: 7,
    id: 'file-token',
    kind: 'file',
    name: 'main.ts',
    path: 'src/main.ts',
    ...overrides,
  })
}

describe('typed Composer drafts', () => {
  it('preserves a bounded Git diff reference as a typed stale-on-restore segment', () => {
    const reference = createComposerContextReference({
      catalogRevision: 12,
      id: 'ctx:git:revision',
      kind: 'git_diff',
      name: 'Current changes',
      path: 'git-diff',
      summary: {
        kind: 'git_diff', scope: 'all', file_count: 3, hunk_count: 5, byte_count: 2048,
      },
    })
    const draft = appendComposerContext(textComposerDraft(), reference)

    expect(composerDraftToStructuredSegments(draft)).toContainEqual({
      kind: 'context_ref',
      id: 'ctx:git:revision',
      catalog_revision: 12,
      context_kind: 'git_diff',
    })
    expect(composerDraftPlainText(draft)).toBe('@git-diff ')
    const restored = parseStoredComposerDraft(serializeComposerDraft(draft))
    expect(composerDraftReferences(restored)[0]).toMatchObject({
      kind: 'git_diff',
      availability: 'stale',
      summary: { file_count: 3, hunk_count: 5, byte_count: 2048 },
    })
  })

  it('restores a terminal capture as stale until the live server validates reconnect state', () => {
    const reference = createComposerContextReference({
      catalogRevision: 18,
      id: 'ctx:terminal:capture',
      kind: 'terminal',
      name: 'Terminal pane 2 · selection · 3 lines · 48 bytes',
      path: 'terminal',
      summary: {
        kind: 'terminal', capture: 'selection', pane_index: 2,
        line_count: 3, byte_count: 48, truncated: false,
      },
    })
    const restored = parseStoredComposerDraft(serializeComposerDraft(
      appendComposerContext(textComposerDraft(), reference),
    ))
    expect(composerDraftReferences(restored)[0]).toMatchObject({
      availability: 'stale',
      kind: 'terminal',
      summary: { capture: 'selection', pane_index: 2, line_count: 3, byte_count: 48 },
    })

    const validated = applyComposerContextValidation(restored, {
      catalog: { ...catalog, revision: 18 },
      references: [{
        id: reference.id,
        catalog_revision: reference.catalogRevision,
        context_kind: 'terminal',
        available: true,
      }],
    })
    expect(composerDraftReferences(validated)[0]?.availability).toBe('available')
    expect(JSON.stringify(composerDraftToStructuredSegments(validated))).not.toContain('Terminal pane')
  })

  it('migrates legacy string drafts without trusting @ text as context', () => {
    expect(parseStoredComposerDraft('@src/main.ts please review')).toEqual(
      textComposerDraft('@src/main.ts please review'),
    )
  })

  it('restores ordered file and directory references as unvalidated', () => {
    const file = context()
    const directory = context({
      id: 'directory-token',
      kind: 'directory',
      name: 'components',
      path: 'src/components',
    })
    const draft: ComposerDraft = {
      version: 2,
      segments: [
        { kind: 'text' as const, text: 'Review ' },
        { kind: 'context' as const, reference: file },
        { kind: 'text' as const, text: ' and ' },
        { kind: 'context' as const, reference: directory },
      ],
    }

    const restored = parseStoredComposerDraft(serializeComposerDraft(draft))
    expect(restored.segments).toEqual(draft.segments.map((segment) => (
      segment.kind === 'text'
        ? segment
        : { ...segment, reference: { ...segment.reference, availability: 'stale' } }
    )))
    expect(composerDraftPlainText(draft)).toBe('Review @src/main.ts and @src/components')
  })

  it('never trusts persisted reference availability during hydration', () => {
    const stored = serializeComposerDraft({
      version: 2,
      segments: [{
        kind: 'context',
        reference: context({
          availability: 'available',
          id: 'browser-invented-token',
        }),
      }],
    })

    expect(composerDraftReferences(parseStoredComposerDraft(stored))[0]?.availability).toBe('stale')
  })

  it('applies late validation without overwriting references added to the newest draft', () => {
    const restored = context({
      availability: 'stale',
      id: 'restored-token',
    })
    const selected = context({
      id: 'selected-token',
      kind: 'directory',
      name: 'components',
      path: 'src/components',
    })
    const newestDraft: ComposerDraft = {
      version: 2,
      segments: [
        { kind: 'context' as const, reference: restored },
        { kind: 'text' as const, text: ' and ' },
        { kind: 'context' as const, reference: selected },
      ],
    }

    const validated = applyComposerContextValidation(
      newestDraft,
      {
        catalog,
        references: [{
          id: restored.id,
          catalog_revision: restored.catalogRevision,
          context_kind: restored.kind,
          available: true,
        }],
      },
    )

    expect(composerDraftReferences(validated).map(({ id, availability }) => (
      [id, availability]
    ))).toEqual([
      ['restored-token', 'available'],
      ['selected-token', 'available'],
    ])
  })

  it('uses private editor tokens only for explicitly selected references', () => {
    const reference = context({ id: 'selected-token' })
    const draft: ComposerDraft = {
      version: 2,
      segments: [
        { kind: 'text' as const, text: 'Look at ' },
        { kind: 'context' as const, reference },
        { kind: 'text' as const, text: ' please' },
      ],
    }
    const editorValue = composerDraftToEditorValue(draft)

    expect(editorValue).toBe('Look at [[selected-token]] please')
    expect(composerDraftFromEditorValue(editorValue, [reference])).toEqual(draft)
    expect(composerDraftFromEditorValue('@src/main.ts', [reference])).toEqual(
      textComposerDraft('@src/main.ts'),
    )
  })

  it('downgrades malformed or absolute persisted references to ordinary fallback text', () => {
    const stored = JSON.stringify({
      version: 2,
      segments: [
        { kind: 'context', reference: {
          id: 'bad', catalogRevision: 7, kind: 'file', name: 'passwd', path: '/etc/passwd', availability: 'available',
        } },
      ],
    })

    expect(parseStoredComposerDraft(stored)).toEqual(textComposerDraft('@/etc/passwd'))
  })

  it('appends command text without flattening existing context segments', () => {
    const reference = context({ id: 'context-token' })
    const draft: Parameters<typeof appendComposerText>[0] = {
      version: 2,
      segments: [{ kind: 'context', reference }],
    }

    const appended = appendComposerText(draft, '/review ')

    expect(appended.segments[0]).toEqual({ kind: 'context', reference })
    expect(composerDraftPlainText(appended)).toBe('@src/main.ts /review ')
  })

  it('caps the number of active typed references in a draft', () => {
    let draft = textComposerDraft()
    for (let index = 0; index <= MAX_COMPOSER_CONTEXT_REFERENCES; index += 1) {
      draft = appendComposerContext(draft, context({
        id: `context-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
      }))
    }

    expect(composerDraftReferences(draft)).toHaveLength(MAX_COMPOSER_CONTEXT_REFERENCES)
  })

  it('migrates v1 context chips to readable text instead of trusting legacy identifiers', () => {
    const restored = parseStoredComposerDraft(JSON.stringify({
      version: 1,
      segments: [
        { kind: 'text', text: 'Review ' },
        { kind: 'context', reference: { path: 'src/main.ts', id: 'legacy-token' } },
      ],
    }))

    expect(restored).toEqual(textComposerDraft('Review @src/main.ts'))
    expect(composerDraftReferences(restored)).toEqual([])
  })

  it('serializes only opaque context coordinates and ordered command arguments', () => {
    const reference = context({ id: 'ctx:opaque' })
    const draft: ComposerDraft = {
      version: 2,
      segments: [
        { kind: 'text', text: '/review focus ' },
        { kind: 'context', reference },
        { kind: 'text', text: ' last' },
      ],
    }

    expect(composerDraftToStructuredSegments(draft, 'review')).toEqual([
      { kind: 'text', text: 'focus ' },
      { kind: 'context_ref', id: 'ctx:opaque', catalog_revision: 7, context_kind: 'file' },
      { kind: 'text', text: ' last' },
    ])
    expect(JSON.stringify(composerDraftToStructuredSegments(draft, 'review'))).not.toContain('src/main.ts')
  })

  it('restores capability references as unsupported readable fallbacks', () => {
    const restored = parseStoredComposerDraft(JSON.stringify({
      version: 2,
      segments: [{
        kind: 'capability',
        reference: {
          id: 'cap:opaque',
          catalogRevision: 9,
          itemKind: 'skill',
          name: 'summarize',
          availability: 'available',
        },
      }],
    }))

    expect(composerDraftCapabilityReferences(restored)[0]?.availability).toBe('unsupported')
    expect(composerDraftPlainText(restored)).toBe('$summarize')
  })

  it('revalidates capability provenance only against an exact current catalog identity', () => {
    const restored = parseStoredComposerDraft(JSON.stringify({
      version: 2,
      segments: [{
        kind: 'capability',
        reference: {
          id: 'cap:opaque', catalogRevision: 9, itemKind: 'skill', name: 'review',
          availability: 'available',
        },
      }],
    }))
    const currentCatalog = {
      conversation_id: 'session-1', revision: 9, contexts: [],
      items: [{
        id: 'cap:opaque', kind: 'skill' as const, name: 'review', description: null,
        source_label: 'Project skill', scope: 'project' as const, input_hint: null,
        enabled: true, disabled_reason: null,
      }],
    }

    const available = applyComposerCatalogSnapshot(restored, currentCatalog)
    expect(composerDraftCapabilityReferences(available)[0]).toMatchObject({
      availability: 'available', sourceLabel: 'Project skill', scope: 'project',
    })
    const stale = applyComposerCatalogSnapshot(available, { ...currentCatalog, revision: 10 })
    expect(composerDraftCapabilityReferences(stale)[0]?.availability).toBe('stale')
  })
})
