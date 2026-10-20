/**
 * Which General draft a reference found elsewhere is added to (ADR 0231 §5),
 * and how the researcher gets back to it. The target lives in page memory
 * only: never a route, storage, or analytics.
 */

import { useCallback } from 'react'

import type { Translator } from '@/lib/i18n'

import { placeKey, usePlaceMemory, usePlaceState } from '../app/location/placeMemory'
import { useWorkspaceNavigation, type WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { emptyGeneralDraft, type GeneralDraft } from '../channel/generalDraft'
import { attachToDraft, draftHas, MAX_DRAFT_REFERENCES, type AttachResult, type DraftReference } from './draftReferences'

/** A draft waiting for a reference while the researcher browses Resources. */
export type AttachTarget = {
  /** The General view whose draft receives it (its Task filter). */
  filter: string | null
  /** A `data-focus-key` to land on when returning. */
  focusKey: string
}

export const attachTargetKey = (projectId: string) => `${projectId}|attach-target`
export const generalDraftKey = (projectId: string, filter: string | null) => `${placeKey.general(projectId, filter)}#draft`
/** Where the composer keeps its caret while the researcher is away finding something. */
export const draftCaretKey = (projectId: string, filter: string | null) => `${placeKey.general(projectId, filter)}#caret`

export function useAttachTarget(projectId: string | null): [AttachTarget | null, (target: AttachTarget | null) => void] {
  return usePlaceState<AttachTarget | null>(projectId && attachTargetKey(projectId), null)
}

export type DraftAttachment = {
  /** `message`: a draft on screen or waiting for this; `general`: General's remembered draft. */
  label: 'message' | 'general'
  /** The place in words, for "Adds … to your message in {place}". */
  place: string
  has(ref: DraftReference['ref']): boolean
  full: boolean
  attach(reference: DraftReference): AttachResult
}

function draftFilter(navigation: WorkspaceNavigation, target: AttachTarget | null): { filter: string | null; label: 'message' | 'general' } | null {
  if (target) return { filter: target.filter, label: 'message' }
  const { place } = navigation.location
  switch (place.view) {
    case 'general':
      return { filter: place.filter ?? null, label: 'message' }
    case 'board':
    case 'resources':
    case 'members':
      return { filter: navigation.rememberedGeneral?.().filter ?? null, label: 'general' }
    default:
      return null
  }
}

/**
 * Adds a reference to the right General draft: the one waiting for it, the
 * one on screen, or General's remembered one. Waiting or covered drafts are
 * returned to, with the composer focused; a draft beside the preview stays.
 * Null where no General draft belongs (a private conversation, history).
 */
export function useAttachToDraft(t: Translator): DraftAttachment | null {
  const navigation = useWorkspaceNavigation()
  const memory = usePlaceMemory()
  const { projectId } = navigation
  const [target, setTarget] = useAttachTarget(projectId)
  const resolved = draftFilter(navigation, target)
  const key = resolved ? generalDraftKey(projectId, resolved.filter) : null
  const [draft, setDraft] = usePlaceState<GeneralDraft>(key, emptyGeneralDraft(resolved?.filter ?? null))
  const attach = useCallback((reference: DraftReference): AttachResult => {
    if (!resolved || !key) return 'full'
    const current = (memory?.has(key) ? memory.get(key) : emptyGeneralDraft(resolved.filter)) as GeneralDraft
    const { draft: next, result } = attachToDraft(current, reference)
    if (result === 'added' || result === 'replaced') setDraft(next)
    if (result === 'full' || result === 'duplicate') return result
    if (target) {
      setTarget(null)
      navigation.openPlace({ view: 'general', filter: target.filter }, { inspector: 'closed', focus: target.focusKey })
    } else if (navigation.location.place.view === 'general' && navigation.presentation === 'screen') {
      navigation.openPlace({ view: 'general' }, { inspector: 'closed', focus: 'composer:general' })
    }
    return result
  }, [key, memory, navigation, resolved, setDraft, setTarget, target])
  if (!resolved) return null
  return {
    label: resolved.label,
    place: t('kubecode.resources.placeGeneral'),
    has: (ref) => draftHas(draft, ref),
    full: draft.references.length >= MAX_DRAFT_REFERENCES,
    attach,
  }
}
