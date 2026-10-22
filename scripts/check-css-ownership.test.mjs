import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareWithBaseline, findViolations } from './check-css-ownership.mjs'

test('finds rules that reach into official internals or force with !important', () => {
  const css = [
    '.kubecode-row { display: flex; }',
    ".kubecode-tabs [data-slot='tabs-trigger'] { gap: 4px; }",
    '.kubecode-pad { padding: 0 !important; }',
    '/* [data-slot=x] in a comment is fine */',
    '.kubecode-menu [cmdk-item] { color: red; }',
  ].join('\n')
  assert.deepEqual(findViolations(css).map((v) => [v.line, v.kind]), [[2, 'official-internal'], [3, 'important'], [5, 'official-internal']])
})

test('fails on new violations and on stale baseline entries', () => {
  const violations = [{ line: 1, text: 'a !important', kind: 'important' }, { line: 2, text: 'b !important', kind: 'important' }]
  const { added, stale } = compareWithBaseline(violations, [{ text: 'a !important' }, { text: 'gone !important' }])
  assert.deepEqual(added.map((v) => v.text), ['b !important'])
  assert.deepEqual(stale, ['gone !important'])
})
