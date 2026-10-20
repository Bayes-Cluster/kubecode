/**
 * Reviewing a Task's results (ADR 0230 §4): a changed record is accepted only
 * at the version the researcher was actually shown, and every pin of it moves
 * to exactly that version. Pure, so the rules are tested without a DOM.
 */

import type { TaskDetail, TaskEvidence, TaskEvidenceCitation, WorkOutcome } from '../api'

export type VersionCheck =
  /** It is current, or never pinned: nothing to accept. */
  | { state: 'not_needed' }
  /** It is gone: the researcher acknowledges that instead. */
  | { state: 'removed' }
  /** It changed and was never shown successfully in this inspector. */
  | { state: 'unseen' }
  /** It was shown, but the record has no version, so a change cannot be accepted. */
  | { state: 'unversioned' }
  /** It was shown at a version that is not the current one. */
  | { state: 'seen_older'; seen: string }
  /** It was shown at the current version, which may be accepted. */
  | { state: 'seen_current'; seen: string }

/** `displayed`: the inspection record's revision (`undefined` never shown, `null` shown without one). */
export function versionCheck(evidence: TaskEvidence, displayed: string | null | undefined): VersionCheck {
  if (evidence.status === 'current' || evidence.status === 'unpinned') return { state: 'not_needed' }
  if (evidence.status === 'removed') return { state: 'removed' }
  if (displayed === undefined) return { state: 'unseen' }
  if (displayed === null) return { state: 'unversioned' }
  return displayed === evidence.current ? { state: 'seen_current', seen: displayed } : { state: 'seen_older', seen: displayed }
}

export type AcceptBlocker = 'archived' | 'changed' | 'removed_ack' | 'outcome' | null

/** Why results cannot be accepted yet, the first reason in this order. */
export function acceptBlocker(detail: TaskDetail, ackRemoved: boolean, outcome: WorkOutcome): AcceptBlocker {
  const evidence = detail.evidence ?? []
  if (detail.archived) return 'archived'
  if (evidence.some((row) => row.status === 'changed')) return 'changed'
  if (evidence.some((row) => row.status === 'removed') && !ackRemoved) return 'removed_ack'
  if (outcome === 'unknown') return 'outcome'
  return null
}

export function reviewEvidence(detail: TaskDetail): { review: TaskEvidence[]; accepted: TaskEvidence[]; other: TaskEvidence[] } {
  const evidence = detail.evidence ?? []
  return {
    review: evidence.filter((row) => row.in_review),
    accepted: evidence.filter((row) => !row.in_review && row.accepted),
    other: evidence.filter((row) => !row.in_review && !row.accepted),
  }
}

/** Every pin of a record that is not at its current version. */
export function repinsFor(evidence: TaskEvidence): TaskEvidenceCitation[] {
  return evidence.cited_by.filter((citation) => citation.pinned !== null && citation.pinned !== evidence.current)
}
