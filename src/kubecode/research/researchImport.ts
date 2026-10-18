import type {
  ResearchBrief,
  ResearchBriefPatch,
  ResearchImportCandidate,
  ResearchImportCandidateKind,
} from '../api'

/** Mirrors the server's brief limits so a proposal is refused before it is sent. */
export const MAX_BRIEF_LIST_ITEMS = 20
export const MAX_BRIEF_ITEM_CHARS = 1_000
export const MAX_IMPORT_BYTES = 64 * 1024

type ListField = 'hypotheses' | 'constraints' | 'evaluation_criteria'

/** How one brief field would change if the selected candidates were applied. */
export type BriefChange =
  | { field: 'question'; before: string; after: string }
  | { field: ListField; before: string[]; after: string[]; added: string[] }

export type BriefProposal = {
  /** Only the fields that change; empty means there is nothing to apply. */
  patch: ResearchBriefPatch
  changes: BriefChange[]
  /** Candidates to record as researcher decision notes (not brief fields). */
  decisions: string[]
  /** A list would exceed the brief's limits. */
  overLimit: boolean
}

const LIST_FIELDS: Partial<Record<ResearchImportCandidateKind, ListField>> = {
  hypothesis: 'hypotheses',
  constraint: 'constraints',
  evaluation_criterion: 'evaluation_criteria',
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

/**
 * The comparison the researcher reviews: the current brief against the brief
 * that would result from the selected candidates. Questions replace the
 * question (the first selected wins), hypotheses, constraints, and evaluation
 * criteria are appended once, decisions become notes, and open questions never
 * change the brief. Nothing here is applied; the caller sends it under the
 * revision the researcher is looking at.
 */
export function proposeBrief(
  brief: ResearchBrief,
  candidates: ResearchImportCandidate[],
  selected: ReadonlySet<number>,
): BriefProposal {
  const chosen = candidates.filter((_, index) => selected.has(index))
  const patch: ResearchBriefPatch = {}
  const changes: BriefChange[] = []
  let overLimit = false

  const question = chosen.find((candidate) => candidate.kind === 'question')
  if (question && !sameText(question.text, brief.question)) {
    patch.question = question.text
    changes.push({ field: 'question', before: brief.question, after: question.text })
  }

  for (const field of ['hypotheses', 'constraints', 'evaluation_criteria'] as const) {
    const current = brief[field]
    const added: string[] = []
    for (const candidate of chosen) {
      if (LIST_FIELDS[candidate.kind] !== field) continue
      if (current.some((item) => sameText(item, candidate.text))) continue
      if (added.some((item) => sameText(item, candidate.text))) continue
      added.push(candidate.text)
    }
    if (added.length === 0) continue
    const after = [...current, ...added]
    if (after.length > MAX_BRIEF_LIST_ITEMS || added.some((item) => item.length > MAX_BRIEF_ITEM_CHARS)) {
      overLimit = true
    }
    patch[field] = after
    changes.push({ field, before: current, after, added })
  }

  const decisions = chosen
    .filter((candidate) => candidate.kind === 'decision')
    .map((candidate) => candidate.text)
  return { patch, changes, decisions, overLimit }
}

/** Candidate kinds in the order the review lists them. */
export const CANDIDATE_KIND_ORDER: ResearchImportCandidateKind[] = [
  'question',
  'hypothesis',
  'constraint',
  'evaluation_criterion',
  'decision',
  'open_question',
]

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
