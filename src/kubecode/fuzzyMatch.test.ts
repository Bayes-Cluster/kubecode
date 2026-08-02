import { describe, expect, it } from 'vitest'

import { fuzzyMatchRank } from './fuzzyMatch'

const standardWeights = {
  empty: 5,
  exact: 0,
  prefix: 1,
  secondary: 4,
  subsequence: 3,
  substring: 2,
} as const

describe('fuzzy match ranking', () => {
  it('ranks exact, prefix, substring, subsequence, then secondary matches', () => {
    expect(fuzzyMatchRank('review', { primary: ['review'] }, standardWeights)).toBe(0)
    expect(fuzzyMatchRank('review', { primary: ['reviewer'] }, standardWeights)).toBe(1)
    expect(fuzzyMatchRank('review', { primary: ['preview'] }, standardWeights)).toBe(2)
    expect(fuzzyMatchRank('rvw', { primary: ['review'] }, standardWeights)).toBe(3)
    expect(fuzzyMatchRank('review', {
      primary: ['inspect'],
      secondary: ['review changes'],
    }, standardWeights)).toBe(4)
    expect(fuzzyMatchRank('', { primary: ['review'] }, standardWeights)).toBe(5)
  })

  it('supports consumer-specific weights and disabled tiers', () => {
    const substringOnly = {
      empty: 0,
      exact: 0,
      prefix: 0,
      subsequence: null,
      substring: 0,
    } as const

    expect(fuzzyMatchRank('view', { primary: ['review changes'] }, substringOnly)).toBe(0)
    expect(fuzzyMatchRank('rvw', { primary: ['review changes'] }, substringOnly)).toBeNull()
  })

  it('allows consumers to narrow subsequence candidates', () => {
    expect(fuzzyMatchRank('mn', {
      primary: ['main'],
      subsequence: ['src/other.ts'],
    }, standardWeights)).toBeNull()
  })
})
