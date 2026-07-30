import { describe, expect, it } from 'vitest'

import {
  findActiveComposerContextQuery,
  replaceActiveComposerContextQuery,
} from './composerContextQuery'

describe('inline Composer @ query', () => {
  it.each([
    ['@src', 4, { start: 0, query: 'src' }],
    ['review @src/main', 16, { start: 7, query: 'src/main' }],
    ['first line\n@docs', 16, { start: 11, query: 'docs' }],
  ])('opens at the start or after whitespace: %s', (value, caret, expected) => {
    expect(findActiveComposerContextQuery(value, caret)).toEqual(expected)
  })

  it.each([
    ['me@example.com', 14],
    ['prefix@src', 10],
    ['@src trailing', 13],
  ])('does not open inside ordinary text: %s', (value, caret) => {
    expect(findActiveComposerContextQuery(value, caret)).toBeNull()
  })

  it('replaces only the active query and leaves surrounding text intact', () => {
    expect(replaceActiveComposerContextQuery('review @mai now', 11, 'token-1')).toEqual({
      value: 'review [[token-1]]  now',
      nextSelectionIndex: 19,
    })
  })
})
