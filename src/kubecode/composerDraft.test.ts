import { describe, expect, it } from 'vitest'

import {
  applyComposerContextValidation,
  composerDraftFromEditorValue,
  composerDraftPlainText,
  composerDraftToEditorValue,
  appendComposerText,
  appendComposerContext,
  composerDraftReferences,
  MAX_COMPOSER_CONTEXT_REFERENCES,
  createComposerContextReference,
  parseStoredComposerDraft,
  serializeComposerDraft,
  textComposerDraft,
} from './composerDraft'

describe('typed Composer drafts', () => {
  it('migrates legacy string drafts without trusting @ text as context', () => {
    expect(parseStoredComposerDraft('@src/main.ts please review')).toEqual(
      textComposerDraft('@src/main.ts please review'),
    )
  })

  it('restores ordered file and directory references as unvalidated', () => {
    const file = createComposerContextReference({
      id: 'file-token',
      kind: 'file',
      name: 'main.ts',
      path: 'src/main.ts',
    })
    const directory = createComposerContextReference({
      id: 'directory-token',
      kind: 'directory',
      name: 'components',
      path: 'src/components',
    })
    const draft = {
      version: 1 as const,
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
      version: 1,
      segments: [{
        kind: 'context',
        reference: createComposerContextReference({
          availability: 'available',
          id: 'browser-invented-token',
          kind: 'file',
          name: 'main.ts',
          path: 'src/main.ts',
        }),
      }],
    })

    expect(composerDraftReferences(parseStoredComposerDraft(stored))[0]?.availability).toBe('stale')
  })

  it('applies late validation without overwriting references added to the newest draft', () => {
    const restored = createComposerContextReference({
      availability: 'stale',
      id: 'restored-token',
      kind: 'file',
      name: 'main.ts',
      path: 'src/main.ts',
    })
    const selected = createComposerContextReference({
      id: 'selected-token',
      kind: 'directory',
      name: 'components',
      path: 'src/components',
    })
    const newestDraft = {
      version: 1 as const,
      segments: [
        { kind: 'context' as const, reference: restored },
        { kind: 'text' as const, text: ' and ' },
        { kind: 'context' as const, reference: selected },
      ],
    }

    const validated = applyComposerContextValidation(
      newestDraft,
      [restored],
      [{ kind: 'file', path: 'src/main.ts' }],
    )

    expect(composerDraftReferences(validated).map(({ id, availability }) => (
      [id, availability]
    ))).toEqual([
      ['restored-token', 'available'],
      ['selected-token', 'available'],
    ])
  })

  it('uses private editor tokens only for explicitly selected references', () => {
    const reference = createComposerContextReference({
      id: 'selected-token',
      kind: 'file',
      name: 'main.ts',
      path: 'src/main.ts',
    })
    const draft = {
      version: 1 as const,
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
      version: 1,
      segments: [
        { kind: 'context', reference: {
          id: 'bad', kind: 'file', name: 'passwd', path: '/etc/passwd', availability: 'available',
        } },
      ],
    })

    expect(parseStoredComposerDraft(stored)).toEqual(textComposerDraft('@/etc/passwd'))
  })

  it('appends command text without flattening existing context segments', () => {
    const reference = createComposerContextReference({
      id: 'context-token', kind: 'file', name: 'main.ts', path: 'src/main.ts',
    })
    const draft: Parameters<typeof appendComposerText>[0] = {
      version: 1,
      segments: [{ kind: 'context', reference }],
    }

    const appended = appendComposerText(draft, '/review ')

    expect(appended.segments[0]).toEqual({ kind: 'context', reference })
    expect(composerDraftPlainText(appended)).toBe('@src/main.ts /review ')
  })

  it('caps the number of active typed references in a draft', () => {
    let draft = textComposerDraft()
    for (let index = 0; index <= MAX_COMPOSER_CONTEXT_REFERENCES; index += 1) {
      draft = appendComposerContext(draft, createComposerContextReference({
        id: `context-${index}`,
        kind: 'file',
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
      }))
    }

    expect(composerDraftReferences(draft)).toHaveLength(MAX_COMPOSER_CONTEXT_REFERENCES)
  })
})
