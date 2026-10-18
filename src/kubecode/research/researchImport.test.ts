import { describe, expect, it } from 'vitest'

import type { ResearchBrief, ResearchImportCandidate } from '../api'
import { MAX_BRIEF_LIST_ITEMS, proposeBrief } from './researchImport'

const brief: ResearchBrief = {
  title: 'Pruning',
  question: 'Does it hold?',
  motivation: '',
  hypotheses: ['H1'],
  constraints: ['single GPU'],
  evaluation_criteria: [],
}

const candidates: ResearchImportCandidate[] = [
  { kind: 'question', text: 'Does it hold across seeds?', line: 3 },
  { kind: 'constraint', text: 'No more than 4 GPUs', line: 5 },
  { kind: 'constraint', text: 'Single GPU', line: 6 },
  { kind: 'hypothesis', text: 'h2', line: 7 },
  { kind: 'evaluation_criterion', text: 'top-1 accuracy', line: 8 },
  { kind: 'decision', text: 'Use structured pruning only', line: 9 },
  { kind: 'open_question', text: 'What about seeds?', line: 10 },
]

const select = (...indexes: number[]) => new Set(indexes)

describe('proposeBrief', () => {
  it('proposes nothing until something is selected', () => {
    const proposal = proposeBrief(brief, candidates, select())
    expect(proposal.changes).toEqual([])
    expect(proposal.patch).toEqual({})
    expect(proposal.decisions).toEqual([])
  })

  it('replaces the question and appends to lists without touching other fields', () => {
    const proposal = proposeBrief(brief, candidates, select(0, 1, 3, 4))
    expect(proposal.patch).toEqual({
      question: 'Does it hold across seeds?',
      constraints: ['single GPU', 'No more than 4 GPUs'],
      hypotheses: ['H1', 'h2'],
      evaluation_criteria: ['top-1 accuracy'],
    })
    expect(proposal.changes.map((change) => change.field)).toEqual([
      'question', 'hypotheses', 'constraints', 'evaluation_criteria',
    ])
    expect(proposal.patch).not.toHaveProperty('title')
    expect(proposal.overLimit).toBe(false)
  })

  it('skips items the brief already has, ignoring case and spacing', () => {
    const proposal = proposeBrief(brief, candidates, select(2))
    expect(proposal.changes).toEqual([])
    expect(proposal.patch).toEqual({})
  })

  it('records decisions as notes and never turns open questions into brief changes', () => {
    const proposal = proposeBrief(brief, candidates, select(5, 6))
    expect(proposal.decisions).toEqual(['Use structured pruning only'])
    expect(proposal.changes).toEqual([])
    expect(proposal.patch).toEqual({})
  })

  it('uses the first selected question and does not duplicate repeated candidates', () => {
    const repeated: ResearchImportCandidate[] = [
      { kind: 'question', text: 'First?', line: 1 },
      { kind: 'question', text: 'Second?', line: 2 },
      { kind: 'constraint', text: 'Same', line: 3 },
      { kind: 'constraint', text: 'same', line: 4 },
    ]
    const proposal = proposeBrief(brief, repeated, select(0, 1, 2, 3))
    expect(proposal.patch.question).toBe('First?')
    expect(proposal.patch.constraints).toEqual(['single GPU', 'Same'])
  })

  it('flags a proposal that would exceed the brief limits', () => {
    const many = Array.from({ length: MAX_BRIEF_LIST_ITEMS }, (_, n): ResearchImportCandidate => ({
      kind: 'hypothesis', text: `extra ${n}`, line: n + 1,
    }))
    const proposal = proposeBrief(brief, many, new Set(many.map((_, index) => index)))
    expect(proposal.overLimit).toBe(true)
    const long: ResearchImportCandidate[] = [{ kind: 'constraint', text: 'x'.repeat(1_001), line: 1 }]
    expect(proposeBrief(brief, long, select(0)).overLimit).toBe(true)
  })
})
