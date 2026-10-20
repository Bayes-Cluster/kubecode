import { describe, expect, it } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import {
  DEFAULT_SECTIONS,
  RESOURCE_SECTION_ORDER,
  describeScope,
  kindsFor,
  sectionOf,
} from './searchScope'

const t = createTranslator('en')

describe('search scope', () => {
  it('names every section by kind, with execution history off unless chosen', () => {
    expect(DEFAULT_SECTIONS).toEqual(['tasks', 'findings', 'evidence', 'discussions', 'files'])
    expect(kindsFor(DEFAULT_SECTIONS)).toEqual(['research', 'finding', 'experiment', 'artifact', 'import', 'thread', 'file'])
    expect(kindsFor(['history'])).toEqual(['session', 'team', 'team_task', 'work', 'round'])
    expect(RESOURCE_SECTION_ORDER).toContain('history')
  })

  it('never searches the conversation itself or single Session turns', () => {
    const all = kindsFor(RESOURCE_SECTION_ORDER)
    expect(all).not.toContain('channel')
    expect(all).not.toContain('session_turn')
    expect(sectionOf('channel')).toBeNull()
    expect(sectionOf('session_turn')).toBeNull()
    expect(sectionOf('file')).toBe('files')
  })

  it('always sends explicit kinds, in a stable order whatever order they were chosen in', () => {
    expect(kindsFor([])).toEqual([])
    expect(kindsFor(['files', 'tasks'])).toEqual(['research', 'file'])
  })

  it('says what it searches, in which Workspace', () => {
    expect(describeScope(['tasks', 'files'], 'Pruning lab', t, 'en')).toBe('Searching Tasks and Files in Pruning lab.')
    expect(describeScope(DEFAULT_SECTIONS, 'Lab', t, 'en'))
      .toBe('Searching Tasks, Findings, Experiments and artifacts, Discussions, and Files in Lab.')
  })
})
