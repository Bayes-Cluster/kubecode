import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareWithBaseline, findViolations, listStylesheets } from './check-css-ownership.mjs'

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
  assert.deepEqual(stale.map((e) => e.text), ['gone !important'])
})

test('checks a selector that starts with the universal selector or follows a comment', () => {
  const css = [
    '*:has(> [data-slot="button"]) svg { width: 12px; }',
    '/* note */ .kubecode-x [data-slot="badge"] { gap: 0; }',
    '/* a',
    ' * [data-slot=y] inside a comment',
    ' */ .kubecode-y { padding: 0 !important; }',
  ].join('\n')
  assert.deepEqual(findViolations(css).map((v) => v.line), [1, 2, 5])
})

test('records the enclosing selector of a declaration', () => {
  const css = ['.kubecode-a {', '  color: inherit !important;', '}', '.kubecode-b,', '[data-slot="badge"] {', '  gap: 0;', '}'].join('\n')
  assert.deepEqual(findViolations(css).map((v) => [v.line, v.context]), [[2, '.kubecode-a'], [5, '.kubecode-b, [data-slot="badge"]']])
})

test('a listed declaration moved under another selector is new, and its old entry is stale', () => {
  const baseline = [{ file: 'a.css', context: '.kubecode-a', text: 'color: inherit !important;' }]
  const moved = findViolations('.kubecode-b [data-slot="badge"] { x: y; }\n.kubecode-c {\n  color: inherit !important;\n}').map((v) => ({ file: 'a.css', ...v }))
  const { added, stale } = compareWithBaseline(moved, baseline)
  assert.deepEqual(added.map((v) => v.line), [1, 3])
  assert.equal(stale.length, 1)
})

test('lists every stylesheet under src, not only kubecode.css', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = listStylesheets(root, 'src')
  assert.ok(files.includes('src/index.css'))
  assert.ok(files.includes('src/kubecode/kubecode.css'))
})
