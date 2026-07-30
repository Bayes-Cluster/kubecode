import type {
  ComposerCatalogSnapshot,
  ComposerGitDiffSummary,
  ComposerContextValidationResponse,
  ComposerItemKind,
  StructuredComposerSegment,
} from './api'

export type ComposerContextKind = 'file' | 'directory' | 'git_diff'
export type ComposerReferenceAvailability = 'available' | 'stale' | 'unsupported'
export type ComposerCapabilityItemKind = Exclude<ComposerItemKind, 'command'>

export type ComposerContextReference = {
  id: string
  catalogRevision: number
  kind: ComposerContextKind
  name: string
  path: string
  availability: 'available' | 'stale'
  summary?: ComposerGitDiffSummary
}

export type ComposerCapabilityReference = {
  id: string
  catalogRevision: number
  itemKind: ComposerCapabilityItemKind
  name: string
  scope?: ComposerCatalogSnapshot['items'][number]['scope']
  sourceLabel?: string
  availability: ComposerReferenceAvailability
}

export type ComposerDraftSegment =
  | { kind: 'text'; text: string }
  | { kind: 'context'; reference: ComposerContextReference }
  | { kind: 'capability'; reference: ComposerCapabilityReference }

export type ComposerDraft = {
  version: 2
  segments: ComposerDraftSegment[]
}

export type ComposerReference = ComposerContextReference | ComposerCapabilityReference

const CONTEXT_TOKEN_PATTERN = /\[\[([A-Za-z0-9._:-]+)\]\]/g
export const MAX_COMPOSER_CONTEXT_REFERENCES = 32

export function textComposerDraft(text = ''): ComposerDraft {
  return { version: 2, segments: [{ kind: 'text', text }] }
}

export function isProjectRelativePath(path: string): boolean {
  if (!path || path.length > 4_096 || /[\0\r\n]/.test(path)) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

export function createComposerContextReference({
  availability = 'available',
  catalogRevision,
  id,
  kind,
  name,
  path,
  summary,
}: Omit<ComposerContextReference, 'availability'> & {
  availability?: ComposerContextReference['availability']
}): ComposerContextReference {
  if (!isProjectRelativePath(path)) throw new Error('Composer context paths must be Project-relative')
  if (!Number.isSafeInteger(catalogRevision) || catalogRevision <= 0) {
    throw new Error('Composer contexts require a positive catalog revision')
  }
  if (!isComposerContextSummary(kind, summary)) {
    throw new Error('Composer context summary does not match its kind')
  }
  return { availability, catalogRevision, id, kind, name, path, summary }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value)
}

function isCatalogRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isContextReference(value: unknown): value is ComposerContextReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Partial<ComposerContextReference>
  return isOpaqueId(reference.id)
    && isCatalogRevision(reference.catalogRevision)
    && (reference.kind === 'file' || reference.kind === 'directory' || reference.kind === 'git_diff')
    && typeof reference.name === 'string'
    && reference.name.length > 0
    && typeof reference.path === 'string'
    && isProjectRelativePath(reference.path)
    && isComposerContextSummary(reference.kind, reference.summary)
    && (reference.availability === 'available' || reference.availability === 'stale')
}

function isComposerContextSummary(
  kind: ComposerContextKind | undefined,
  summary: unknown,
): summary is ComposerGitDiffSummary | undefined {
  if (kind !== 'git_diff') return summary === undefined
  if (!summary || typeof summary !== 'object') return false
  const candidate = summary as Partial<ComposerGitDiffSummary>
  return candidate.kind === 'git_diff'
    && (candidate.scope === 'all' || candidate.scope === 'file')
    && [candidate.file_count, candidate.hunk_count, candidate.byte_count]
      .every((value) => Number.isSafeInteger(value) && (value ?? -1) >= 0)
}

function isCapabilityReference(value: unknown): value is ComposerCapabilityReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Partial<ComposerCapabilityReference>
  return isOpaqueId(reference.id)
    && isCatalogRevision(reference.catalogRevision)
    && ['skill', 'plugin_action', 'provider_app'].includes(reference.itemKind ?? '')
    && typeof reference.name === 'string'
    && reference.name.length > 0
    && (reference.scope === undefined
      || ['session', 'project', 'user', 'bundled', 'plugin'].includes(reference.scope))
    && (reference.sourceLabel === undefined
      || (typeof reference.sourceLabel === 'string' && reference.sourceLabel.length > 0))
    && ['available', 'stale', 'unsupported'].includes(reference.availability ?? '')
}

export function createComposerCapabilityReference({
  availability = 'available',
  catalogRevision,
  id,
  itemKind,
  name,
  scope,
  sourceLabel,
}: Omit<ComposerCapabilityReference, 'availability' | 'scope' | 'sourceLabel'>
  & Required<Pick<ComposerCapabilityReference, 'scope' | 'sourceLabel'>> & {
  availability?: ComposerCapabilityReference['availability']
}): ComposerCapabilityReference {
  if (!isOpaqueId(id) || !isCatalogRevision(catalogRevision)) {
    throw new Error('Composer capabilities require an opaque ID and positive catalog revision')
  }
  if (!['skill', 'plugin_action', 'provider_app'].includes(itemKind)) {
    throw new Error('Composer capability chips require a user-invocable capability kind')
  }
  if (!name || !sourceLabel || !['session', 'project', 'user', 'bundled', 'plugin'].includes(scope)) {
    throw new Error('Composer capability chips require safe display provenance')
  }
  return { availability, catalogRevision, id, itemKind, name, scope, sourceLabel }
}

function appendText(segments: ComposerDraftSegment[], text: string) {
  if (!text) return
  const previous = segments.at(-1)
  if (previous?.kind === 'text') previous.text += text
  else segments.push({ kind: 'text', text })
}

function normalizeSegments(segments: ComposerDraftSegment[]): ComposerDraftSegment[] {
  const normalized: ComposerDraftSegment[] = []
  for (const segment of segments) {
    if (segment.kind === 'text') appendText(normalized, segment.text)
    else normalized.push(segment)
  }
  return normalized.length > 0 ? normalized : [{ kind: 'text', text: '' }]
}

function migrateV1Segments(rawSegments: unknown[]): ComposerDraft {
  const segments: ComposerDraftSegment[] = []
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== 'object') continue
    const segment = raw as { kind?: unknown; text?: unknown; reference?: { path?: unknown } }
    if (segment.kind === 'text' && typeof segment.text === 'string') appendText(segments, segment.text)
    if (segment.kind === 'context' && typeof segment.reference?.path === 'string') {
      appendText(segments, `@${segment.reference.path}`)
    }
  }
  return { version: 2, segments: normalizeSegments(segments) }
}

export function parseStoredComposerDraft(stored: string | null | undefined): ComposerDraft {
  if (!stored) return textComposerDraft()
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return textComposerDraft(stored)
  }
  if (!parsed || typeof parsed !== 'object') return textComposerDraft(stored)
  const candidate = parsed as { version?: unknown; segments?: unknown }
  if (!Array.isArray(candidate.segments)) return textComposerDraft(stored)
  if (candidate.version === 1) return migrateV1Segments(candidate.segments)
  if (candidate.version !== 2) return textComposerDraft(stored)

  const segments: ComposerDraftSegment[] = []
  let referenceCount = 0
  for (const raw of candidate.segments) {
    if (!raw || typeof raw !== 'object') continue
    const segment = raw as { kind?: unknown; text?: unknown; reference?: unknown }
    if (segment.kind === 'text' && typeof segment.text === 'string') {
      appendText(segments, segment.text)
    } else if (segment.kind === 'context' && isContextReference(segment.reference)) {
      if (referenceCount < MAX_COMPOSER_CONTEXT_REFERENCES) {
        segments.push({
          kind: 'context',
          reference: { ...segment.reference, availability: 'stale' },
        })
        referenceCount += 1
      } else {
        appendText(segments, `@${segment.reference.path}`)
      }
    } else if (segment.kind === 'capability' && isCapabilityReference(segment.reference)) {
      if (referenceCount < MAX_COMPOSER_CONTEXT_REFERENCES) {
        segments.push({
          kind: 'capability',
          reference: { ...segment.reference, availability: 'unsupported' },
        })
        referenceCount += 1
      } else {
        appendText(segments, `$${segment.reference.name}`)
      }
    } else if (segment.kind === 'context') {
      const path = (segment.reference as { path?: unknown } | undefined)?.path
      if (typeof path === 'string') appendText(segments, `@${path}`)
    } else if (segment.kind === 'capability') {
      const name = (segment.reference as { name?: unknown } | undefined)?.name
      if (typeof name === 'string') appendText(segments, `$${name}`)
    }
  }
  return { version: 2, segments: normalizeSegments(segments) }
}

export function serializeComposerDraft(draft: ComposerDraft): string {
  return JSON.stringify({ version: 2, segments: normalizeSegments(draft.segments) })
}

export function composerDraftPlainText(draft: ComposerDraft): string {
  return draft.segments.map((segment) => {
    if (segment.kind === 'text') return segment.text
    return segment.kind === 'context' ? `@${segment.reference.path}` : `$${segment.reference.name}`
  }).join('')
}

export function composerDraftToEditorValue(draft: ComposerDraft): string {
  return draft.segments.map((segment) => (
    segment.kind === 'text' ? segment.text : `[[${segment.reference.id}]]`
  )).join('')
}

function allReferences(draft: ComposerDraft): ComposerReference[] {
  return draft.segments.flatMap((segment) => segment.kind === 'text' ? [] : [segment.reference])
}

export function composerDraftAllReferences(draft: ComposerDraft): ComposerReference[] {
  return allReferences(draft)
}

export function composerDraftFromEditorValue(
  value: string,
  references: ComposerReference[],
): ComposerDraft {
  const referencesById = new Map(references.map((reference) => [reference.id, reference]))
  const segments: ComposerDraftSegment[] = []
  let cursor = 0
  CONTEXT_TOKEN_PATTERN.lastIndex = 0
  for (const match of value.matchAll(CONTEXT_TOKEN_PATTERN)) {
    const start = match.index ?? 0
    const reference = referencesById.get(match[1])
    if (!reference) continue
    appendText(segments, value.slice(cursor, start))
    segments.push('path' in reference
      ? { kind: 'context', reference }
      : { kind: 'capability', reference })
    cursor = start + match[0].length
  }
  appendText(segments, value.slice(cursor))
  return { version: 2, segments: normalizeSegments(segments) }
}

export function composerDraftReferences(draft: ComposerDraft): ComposerContextReference[] {
  return draft.segments.flatMap((segment) => segment.kind === 'context' ? [segment.reference] : [])
}

export function composerDraftCapabilityReferences(draft: ComposerDraft): ComposerCapabilityReference[] {
  return draft.segments.flatMap((segment) => segment.kind === 'capability' ? [segment.reference] : [])
}

export function composerDraftHasStaleContext(draft: ComposerDraft): boolean {
  return allReferences(draft).some((reference) => reference.availability !== 'available')
}

export function composerDraftHasTypedReferences(draft: ComposerDraft): boolean {
  return allReferences(draft).length > 0
}

export function appendComposerContext(
  draft: ComposerDraft,
  reference: ComposerContextReference,
): ComposerDraft {
  if (allReferences(draft).length >= MAX_COMPOSER_CONTEXT_REFERENCES) return draft
  const separator = composerDraftPlainText(draft).length > 0
    && !/\s$/.test(composerDraftPlainText(draft)) ? ' ' : ''
  return {
    version: 2,
    segments: normalizeSegments([
      ...draft.segments,
      { kind: 'text', text: separator },
      { kind: 'context', reference },
      { kind: 'text', text: ' ' },
    ]),
  }
}

export function appendComposerCapability(
  draft: ComposerDraft,
  reference: ComposerCapabilityReference,
): ComposerDraft {
  if (allReferences(draft).length >= MAX_COMPOSER_CONTEXT_REFERENCES) return draft
  const separator = composerDraftPlainText(draft).length > 0
    && !/\s$/.test(composerDraftPlainText(draft)) ? ' ' : ''
  return {
    version: 2,
    segments: normalizeSegments([
      ...draft.segments,
      { kind: 'text', text: separator },
      { kind: 'capability', reference },
      { kind: 'text', text: ' ' },
    ]),
  }
}

export function appendComposerText(draft: ComposerDraft, text: string): ComposerDraft {
  const plainText = composerDraftPlainText(draft)
  const separator = plainText.length > 0 && !/\s$/.test(plainText) ? ' ' : ''
  return {
    version: 2,
    segments: normalizeSegments([
      ...draft.segments,
      { kind: 'text', text: `${separator}${text}` },
    ]),
  }
}

export function applyComposerContextValidation(
  draft: ComposerDraft,
  response: ComposerContextValidationResponse,
): ComposerDraft {
  const results = new Map(response.references.map((reference) => [
    `${reference.id}\0${reference.catalog_revision}\0${reference.context_kind}`,
    reference.available,
  ]))
  let changed = false
  const segments = draft.segments.map((segment) => {
    if (segment.kind !== 'context') return segment
    const key = `${segment.reference.id}\0${segment.reference.catalogRevision}\0${segment.reference.kind}`
    const result = results.get(key)
    if (result === undefined) return segment
    const availability = result ? 'available' : 'stale'
    if (availability === segment.reference.availability) return segment
    changed = true
    return {
      kind: 'context',
      reference: { ...segment.reference, availability },
    } satisfies ComposerDraftSegment
  })
  return changed ? { version: 2, segments } : draft
}

export function applyComposerCatalogSnapshot(
  draft: ComposerDraft,
  catalog: ComposerCatalogSnapshot,
): ComposerDraft {
  const contexts = new Set(catalog.contexts
    .filter((context) => context.enabled)
    .map((context) => `${context.id}\0${context.kind}`))
  const capabilities = new Map(catalog.items.map((item) => [
    `${item.id}\0${item.kind}`,
    item,
  ]))
  let changed = false
  const segments = draft.segments.map((segment) => {
    if (segment.kind === 'text') return segment
    let availability: ComposerReferenceAvailability
    if (segment.kind === 'context') {
      availability = contexts.has(`${segment.reference.id}\0${segment.reference.kind}`)
        ? segment.reference.availability
        : 'stale'
    } else {
      const item = capabilities.get(`${segment.reference.id}\0${segment.reference.itemKind}`)
      availability = segment.reference.catalogRevision === catalog.revision && item?.enabled
        ? 'available'
        : item ? 'stale' : 'unsupported'
    }
    if (segment.kind === 'capability') {
      const item = capabilities.get(`${segment.reference.id}\0${segment.reference.itemKind}`)
      const reference = item ? {
        ...segment.reference,
        availability,
        scope: item.scope,
        sourceLabel: item.source_label,
      } : { ...segment.reference, availability }
      if (availability === segment.reference.availability
        && reference.scope === segment.reference.scope
        && reference.sourceLabel === segment.reference.sourceLabel) return segment
      changed = true
      return { ...segment, reference }
    }
    if (availability === segment.reference.availability) return segment
    changed = true
    return { ...segment, reference: { ...segment.reference, availability } }
  }) as ComposerDraftSegment[]
  return changed ? { version: 2, segments } : draft
}

export function composerDraftToStructuredSegments(
  draft: ComposerDraft,
  commandName?: string,
): StructuredComposerSegment[] {
  const segments = draft.segments.map((segment) => (
    segment.kind === 'text' ? { ...segment } : segment
  ))
  if (commandName && segments[0]?.kind === 'text') {
    const prefix = `/${commandName}`
    const text = segments[0].text
    if (text === prefix) segments[0].text = ''
    else if (text.startsWith(`${prefix} `)) segments[0].text = text.slice(prefix.length + 1)
  }
  return segments.map((segment) => {
    if (segment.kind === 'text') return segment
    if (segment.kind === 'context') {
      return {
        kind: 'context_ref',
        id: segment.reference.id,
        catalog_revision: segment.reference.catalogRevision,
        context_kind: segment.reference.kind,
      }
    }
    return {
      kind: 'capability_ref',
      id: segment.reference.id,
      catalog_revision: segment.reference.catalogRevision,
      item_kind: segment.reference.itemKind,
    }
  })
}
