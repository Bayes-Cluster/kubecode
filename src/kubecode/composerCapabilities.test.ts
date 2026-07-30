import { describe, expect, it } from 'vitest'

import type { ComposerCatalogSnapshot } from './api'
import {
  findActiveComposerCapabilityQuery,
  rankComposerCapabilities,
  replaceActiveComposerCapabilityQuery,
} from './composerCapabilities'

const catalog: ComposerCatalogSnapshot = {
  conversation_id: 'session-1',
  revision: 12,
  contexts: [],
  items: [
    {
      id: 'skill:project:review', kind: 'skill', name: 'review',
      description: 'Inspect current changes', source_label: 'Project skill', scope: 'project',
      input_hint: null, enabled: true, disabled_reason: null,
    },
    {
      id: 'skill:user:review', kind: 'skill', name: 'review',
      description: 'Review with personal rules', source_label: 'User skill', scope: 'user',
      input_hint: null, enabled: false, disabled_reason: 'ambiguous_source_identity',
    },
    {
      id: 'skill:session:reviewer', kind: 'skill', name: 'reviewer',
      description: 'Review a patch', source_label: 'Codex skill', scope: 'session',
      input_hint: null, enabled: true, disabled_reason: null,
    },
    {
      id: 'skill:session:preview', kind: 'skill', name: 'preview',
      description: 'Preview output', source_label: 'Codex skill', scope: 'session',
      input_hint: null, enabled: true, disabled_reason: null,
    },
    {
      id: 'skill:session:rvw', kind: 'skill', name: 'rvw',
      description: 'Compact review helper', source_label: 'Codex skill', scope: 'session',
      input_hint: null, enabled: true, disabled_reason: null,
    },
    {
      id: 'skill:bundled:inspect', kind: 'skill', name: 'inspect',
      description: 'Review an implementation', source_label: 'Bundled skill', scope: 'bundled',
      input_hint: null, enabled: true, disabled_reason: null,
    },
    {
      id: 'skill:session:unsupported', kind: 'skill', name: 'review-unsupported',
      description: 'Unsupported inferred capability', source_label: 'Unknown metadata', scope: 'session',
      input_hint: null, enabled: false, disabled_reason: 'unsupported_invocation',
    },
    {
      id: 'command:review', kind: 'command', name: 'review',
      description: 'Raw ACP command', source_label: 'Codex command', scope: 'session',
      input_hint: null, enabled: true, disabled_reason: null,
    },
  ],
}

describe('Composer capability discovery', () => {
  it.each(['$', '＄', '¥', '￥'])('detects %s only at input start or after whitespace', (trigger) => {
    expect(findActiveComposerCapabilityQuery(`${trigger}rev`, 4)).toMatchObject({
      query: 'rev',
      start: 0,
      trigger,
    })
    expect(findActiveComposerCapabilityQuery(`Use ${trigger}rev`, 8)).toMatchObject({
      query: 'rev',
      start: 4,
      trigger,
    })
    expect(findActiveComposerCapabilityQuery(`price${trigger}rev`, 9)).toBeNull()
  })

  it('normalizes a trigger variant only after an explicit selection', () => {
    expect(replaceActiveComposerCapabilityQuery('Use ￥rev later', 8, 'skill:opaque')).toEqual({
      value: 'Use [[skill:opaque]]  later',
      nextSelectionIndex: 21,
    })
  })

  it('ranks exact, prefix, substring, subsequence, then description matches', () => {
    expect(rankComposerCapabilities(catalog, 'review').map((item) => item.id)).toEqual([
      'skill:project:review',
      'skill:user:review',
      'skill:session:reviewer',
      'skill:session:preview',
      'skill:session:rvw',
      'skill:bundled:inspect',
    ])
  })

  it('preserves duplicate opaque identities and excludes raw commands', () => {
    const matches = rankComposerCapabilities(catalog, 'review')
    expect(matches.filter((item) => item.name === 'review')).toHaveLength(2)
    expect(matches.find((item) => item.id === 'skill:user:review')).toMatchObject({
      enabled: false,
      disabled_reason: 'ambiguous_source_identity',
    })
    expect(matches.some((item) => item.kind === 'command')).toBe(false)
    expect(matches.some((item) => item.id === 'skill:session:unsupported')).toBe(false)
  })
})
