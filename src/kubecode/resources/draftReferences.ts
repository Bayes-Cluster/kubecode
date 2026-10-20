/**
 * References a General draft carries (ADR 0231 §5): each at the version the
 * researcher saw (previewed) or the current one stamped when attaching from
 * the list, one per record, and as many as the server accepts. Pure.
 */

import type { GeneralDraft } from '../channel/generalDraft'
import type { ProjectContextKind } from '../api'

export type DraftReference = {
  ref: { kind: ProjectContextKind; id: string; revision: string | null }
  title: string
  /** `previewed`: the version shown; `listed`: the current one when attached from the list. */
  seen: 'previewed' | 'listed'
}

/** The server's bound on one message's references. */
export const MAX_DRAFT_REFERENCES = 16

/** `replaced`: another version of a record already cited; `replacedTask`: a different Task than the one the message was about. */
export type AttachResult = 'added' | 'replaced' | 'replacedTask' | 'duplicate' | 'full'

/** What to announce after attaching `title`, or null when the draft did not change. */
export function attachAnnouncement(result: AttachResult): 'kubecode.resources.added' | 'kubecode.resources.updated' | 'kubecode.resources.taskReplaced' | null {
  switch (result) {
    case 'added': return 'kubecode.resources.added'
    case 'replaced': return 'kubecode.resources.updated'
    case 'replacedTask': return 'kubecode.resources.taskReplaced'
    default: return null
  }
}

/**
 * The draft with `reference` attached. Another version of a record already
 * cited replaces it. A Task becomes what the message is about (its first
 * reference when sent), not a second reference, at the version attached.
 */
export function attachToDraft(draft: GeneralDraft, reference: DraftReference): { draft: GeneralDraft; result: AttachResult } {
  if (reference.ref.kind === 'research') {
    const revision = reference.ref.revision ?? null
    if (draft.task === reference.ref.id) {
      if ((draft.taskRevision ?? null) === revision) return { draft, result: 'duplicate' }
      return { draft: { ...draft, taskRevision: revision, taskCleared: false }, result: 'replaced' }
    }
    return {
      draft: { ...draft, task: reference.ref.id, taskRevision: revision, taskCleared: false },
      result: draft.task ? 'replacedTask' : 'added',
    }
  }
  const index = draft.references.findIndex((existing) => (
    existing.ref.kind === reference.ref.kind && existing.ref.id === reference.ref.id
  ))
  if (index >= 0) {
    if (draft.references[index].ref.revision === reference.ref.revision) return { draft, result: 'duplicate' }
    const references = [...draft.references]
    references[index] = reference
    return { draft: { ...draft, references }, result: 'replaced' }
  }
  if (draft.references.length >= MAX_DRAFT_REFERENCES) return { draft, result: 'full' }
  return { draft: { ...draft, references: [...draft.references, reference] }, result: 'added' }
}

/** Whether the draft already cites exactly this version (or is about this Task at this version). */
export function draftHas(draft: GeneralDraft, ref: DraftReference['ref']): boolean {
  if (ref.kind === 'research') return draft.task === ref.id && (draft.taskRevision ?? null) === (ref.revision ?? null)
  return draft.references.some((existing) => (
    existing.ref.kind === ref.kind && existing.ref.id === ref.id && existing.ref.revision === ref.revision
  ))
}
