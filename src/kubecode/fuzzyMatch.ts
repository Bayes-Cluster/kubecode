export type FuzzyMatchWeights = {
  empty: number | null
  exact: number | null
  prefix: number | null
  secondary?: number | null
  subsequence: number | null
  substring: number | null
}

export function fuzzyMatchRank(
  query: string,
  candidates: {
    primary: readonly string[]
    secondary?: readonly string[]
    subsequence?: readonly string[]
  },
  weights: FuzzyMatchWeights,
): number | null {
  if (!query) return weights.empty
  if (candidates.primary.some((candidate) => candidate === query)) return weights.exact
  if (candidates.primary.some((candidate) => candidate.startsWith(query))) return weights.prefix
  if (candidates.primary.some((candidate) => candidate.includes(query))) return weights.substring
  if ((candidates.subsequence ?? candidates.primary).some((candidate) => isSubsequence(query, candidate))) {
    return weights.subsequence
  }
  if (candidates.secondary?.some((candidate) => candidate.includes(query))) {
    return weights.secondary ?? null
  }
  return null
}

function isSubsequence(query: string, candidate: string): boolean {
  let queryIndex = 0
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return false
}
