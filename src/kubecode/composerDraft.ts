export type ComposerContextKind = 'file' | 'directory'
export type ComposerContextAvailability = 'available' | 'stale'

export type ComposerContextReference = {
  id: string
  kind: ComposerContextKind
  name: string
  path: string
  availability: ComposerContextAvailability
}

export type ComposerDraftSegment =
  | { kind: 'text'; text: string }
  | { kind: 'context'; reference: ComposerContextReference }

export type ComposerDraft = {
  version: 1
  segments: ComposerDraftSegment[]
}

const CONTEXT_TOKEN_PATTERN = /\[\[([^[\]\r\n]+)\]\]/g
export const MAX_COMPOSER_CONTEXT_REFERENCES = 32

export function textComposerDraft(text = ''): ComposerDraft {
  return { version: 1, segments: [{ kind: 'text', text }] }
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
  id = globalThis.crypto?.randomUUID?.() ?? `context-${Date.now()}-${Math.random()}`,
  kind,
  name,
  path,
}: Omit<ComposerContextReference, 'availability' | 'id'> & {
  availability?: ComposerContextAvailability
  id?: string
}): ComposerContextReference {
  if (!isProjectRelativePath(path)) throw new Error('Composer context paths must be Project-relative')
  return { availability, id, kind, name, path }
}

function isContextReference(value: unknown): value is ComposerContextReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Partial<ComposerContextReference>
  return typeof reference.id === 'string'
    && /^[A-Za-z0-9._:-]+$/.test(reference.id)
    && (reference.kind === 'file' || reference.kind === 'directory')
    && typeof reference.name === 'string'
    && reference.name.length > 0
    && typeof reference.path === 'string'
    && isProjectRelativePath(reference.path)
    && (reference.availability === 'available' || reference.availability === 'stale')
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
  if (candidate.version !== 1 || !Array.isArray(candidate.segments)) return textComposerDraft(stored)

  const segments: ComposerDraftSegment[] = []
  let contextCount = 0
  for (const raw of candidate.segments) {
    if (!raw || typeof raw !== 'object') continue
    const segment = raw as { kind?: unknown; text?: unknown; reference?: unknown }
    if (segment.kind === 'text' && typeof segment.text === 'string') {
      appendText(segments, segment.text)
    } else if (segment.kind === 'context') {
      if (isContextReference(segment.reference)) {
        if (contextCount < MAX_COMPOSER_CONTEXT_REFERENCES) {
          segments.push({
            kind: 'context',
            reference: { ...segment.reference, availability: 'stale' },
          })
          contextCount += 1
        } else {
          appendText(segments, `@${segment.reference.path}`)
        }
      } else {
        const path = (segment.reference as { path?: unknown } | undefined)?.path
        if (typeof path === 'string') appendText(segments, `@${path}`)
      }
    }
  }
  return { version: 1, segments: normalizeSegments(segments) }
}

export function serializeComposerDraft(draft: ComposerDraft): string {
  return JSON.stringify({ version: 1, segments: normalizeSegments(draft.segments) })
}

export function composerDraftPlainText(draft: ComposerDraft): string {
  return draft.segments.map((segment) => (
    segment.kind === 'text' ? segment.text : `@${segment.reference.path}`
  )).join('')
}

export function composerDraftToEditorValue(draft: ComposerDraft): string {
  return draft.segments.map((segment) => (
    segment.kind === 'text' ? segment.text : `[[${segment.reference.id}]]`
  )).join('')
}

export function composerDraftFromEditorValue(
  value: string,
  references: ComposerContextReference[],
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
    segments.push({ kind: 'context', reference })
    cursor = start + match[0].length
  }
  appendText(segments, value.slice(cursor))
  return { version: 1, segments: normalizeSegments(segments) }
}

export function composerDraftReferences(draft: ComposerDraft): ComposerContextReference[] {
  return draft.segments.flatMap((segment) => segment.kind === 'context' ? [segment.reference] : [])
}

export function composerDraftHasStaleContext(draft: ComposerDraft): boolean {
  return composerDraftReferences(draft).some((reference) => reference.availability === 'stale')
}

export function appendComposerContext(
  draft: ComposerDraft,
  reference: ComposerContextReference,
): ComposerDraft {
  if (composerDraftReferences(draft).length >= MAX_COMPOSER_CONTEXT_REFERENCES) return draft
  const separator = composerDraftPlainText(draft).length > 0
    && !/\s$/.test(composerDraftPlainText(draft)) ? ' ' : ''
  return {
    version: 1,
    segments: normalizeSegments([
      ...draft.segments,
      { kind: 'text', text: separator },
      { kind: 'context', reference },
      { kind: 'text', text: ' ' },
    ]),
  }
}

export function appendComposerText(draft: ComposerDraft, text: string): ComposerDraft {
  const plainText = composerDraftPlainText(draft)
  const separator = plainText.length > 0 && !/\s$/.test(plainText) ? ' ' : ''
  return {
    version: 1,
    segments: normalizeSegments([
      ...draft.segments,
      { kind: 'text', text: `${separator}${text}` },
    ]),
  }
}

type ComposerContextIdentity = Pick<ComposerContextReference, 'id' | 'kind' | 'path'>
type AvailableComposerContext = Pick<ComposerContextReference, 'kind' | 'path'>

function composerContextKey(context: AvailableComposerContext): string {
  return `${context.kind}\0${context.path}`
}

export function applyComposerContextValidation(
  draft: ComposerDraft,
  requestedReferences: ComposerContextIdentity[],
  availableContexts: AvailableComposerContext[],
): ComposerDraft {
  const requestedById = new Map(requestedReferences.map((reference) => [reference.id, reference]))
  const availableKeys = new Set(availableContexts.map(composerContextKey))
  let changed = false
  const segments = draft.segments.map((segment) => {
    if (segment.kind === 'text') return segment
    const requested = requestedById.get(segment.reference.id)
    if (!requested
      || requested.kind !== segment.reference.kind
      || requested.path !== segment.reference.path) return segment
    const availability = availableKeys.has(composerContextKey(segment.reference))
      ? 'available'
      : 'stale'
    if (availability === segment.reference.availability) return segment
    changed = true
    return {
      kind: 'context',
      reference: {
        ...segment.reference,
        availability,
      },
    } satisfies ComposerDraftSegment
  })
  return changed ? { version: 1, segments } : draft
}
