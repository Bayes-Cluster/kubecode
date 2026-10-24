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

// ADR 0255: the checker also sees rules applied to official components by
// className, element reach-ins, third-party internals and dead classes.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  classNameUses,
  collectClassUsage,
  findAppearanceOnOfficial,
  findDeadClasses,
  findDeadRules,
  findReachIns,
  officialImports,
  parseRules,
  splitCompounds,
} from './check-css-ownership.mjs'

test('parses rules with their declarations, nested under at-rules', () => {
  const rules = parseRules('@media (pointer: coarse) {\n  .kubecode-a, .kubecode-b { color: red; gap: 4px }\n}\n.kubecode-c { padding: 0; }')
  assert.deepEqual(rules.map((rule) => [rule.selector, rule.path, rule.declarations.map((d) => d.property)]), [
    ['.kubecode-a, .kubecode-b', '@media (pointer: coarse) / .kubecode-a, .kubecode-b', ['color', 'gap']],
    ['.kubecode-c', '.kubecode-c', ['padding']],
  ])
})

test('splits compounds at combinators but not inside brackets', () => {
  assert.deepEqual(splitCompounds('.a > .b:not(.c > .d) [data-x="1 2"] .e'), ['.a', '.b:not(.c > .d)', '[data-x="1 2"]', '.e'])
})

test('flags third-party internals as their own kind', () => {
  const css = '.kubecode-editor > .cm-editor { height: 100%; }\n.ai-markdown .hljs-keyword { color: red; }\n.kubecode-terminal .xterm { height: 100%; }'
  assert.deepEqual(findViolations(css).map((v) => [v.line, v.kind]), [[1, 'third-party-internal'], [2, 'third-party-internal'], [3, 'third-party-internal']])
})

test('flags rules that reach descendant elements or roles through a combinator', () => {
  const css = [
    '.kubecode-footer button { color: red; }',
    '.kubecode-tree [role="treeitem"] { padding: 0; }',
    '.kubecode-body :is(th, td) { word-break: normal; }',
    '.kubecode-row { display: flex; }',
    'button, [role="button"] { cursor: pointer; }',
    '.kubecode-list > .kubecode-item { gap: 4px; }',
  ].join('\n')
  assert.deepEqual(findReachIns(css).map((v) => [v.line, v.kind, v.text]), [
    [1, 'element-reach-in', '.kubecode-footer button'],
    [2, 'element-reach-in', '.kubecode-tree [role="treeitem"]'],
    [3, 'element-reach-in', '.kubecode-body :is(th, td)'],
  ])
})

test('maps className on official imports to the component, by alias or relative path', () => {
  const source = [
    "import { Button } from '@/components/ui/button'",
    "import { Item as Row, type ItemProps } from '../../components/ui/item'",
    "import { Message } from '@/components/ai-elements/message'",
    "import { Chip } from './Chip'",
    '',
    'export const X = () => (',
    '  <Row className={cn("kubecode-row", open && "is-open")}>',
    '    <Button className="kubecode-row-button shrink-0">go</Button>',
    '    <Chip className="kubecode-chip" />',
    '    <div className="kubecode-plain" />',
    '  </Row>',
    ')',
  ].join('\n')
  assert.deepEqual([...officialImports(source, 'src/kubecode/work/X.tsx', '/repo')], ['Button', 'Row', 'Message'])
  assert.deepEqual(classNameUses(source).map((use) => [use.tag, use.classes, use.line]), [
    ['Row', ['kubecode-row', 'is-open'], 7],
    ['Button', ['kubecode-row-button', 'shrink-0'], 8],
    ['Chip', ['kubecode-chip'], 9],
    ['div', ['kubecode-plain'], 10],
  ])
})

test('flags appearance declarations on a class an official component carries, not layout ones', () => {
  const official = new Map([['kubecode-row', new Set(['Item'])], ['kubecode-row-button', new Set(['Button'])]])
  const css = [
    '.kubecode-row { display: flex; padding: 0; min-height: 0; }',
    '.kubecode-panel .kubecode-row-button { height: 26px; font-size: 14px; }',
    '.kubecode-row .kubecode-plain { color: red; }',
    '.kubecode-plain { border: 1px solid red; }',
  ].join('\n')
  assert.deepEqual(findAppearanceOnOfficial(css, official).map((v) => [v.line, v.text, v.component]), [
    [1, 'padding: 0;', 'Item'],
    [2, 'height: 26px;', 'Button'],
    [2, 'font-size: 14px;', 'Button'],
  ])
})

test('lists dead rules and dead classes both ways', () => {
  const css = '.kubecode-used { gap: 4px; }\n.kubecode-gone .kubecode-used { gap: 0; }'
  assert.deepEqual(findDeadRules(css, new Set(['kubecode-used'])).map((v) => [v.line, v.text, v.kind]), [[2, '.kubecode-gone', 'dead-rule']])
  const classNamed = new Map([['kubecode-used', { file: 'a.tsx', line: 3 }], ['kubecode-styleless', { file: 'b.tsx', line: 9 }]])
  assert.deepEqual(findDeadClasses(classNamed, [css]).map((v) => [v.file, v.line, v.text, v.kind]), [['b.tsx', 9, 'kubecode-styleless', 'dead-class']])
})

test('collects class usage from a product tree, skipping tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'css-ownership-'))
  mkdirSync(join(root, 'src/components/ui'), { recursive: true })
  mkdirSync(join(root, 'src/kubecode'), { recursive: true })
  writeFileSync(join(root, 'src/components/ui/badge.tsx'), 'export const Badge = () => null')
  writeFileSync(join(root, 'src/kubecode/View.tsx'), "import { Badge } from '@/components/ui/badge'\nexport const V = () => <Badge className=\"kubecode-count\" />\n")
  writeFileSync(join(root, 'src/kubecode/View.test.tsx'), "const x = 'kubecode-only-in-test'")
  writeFileSync(join(root, 'src/kubecode/hook.ts'), "export const q = '.kubecode-mentioned'")
  const usage = collectClassUsage(root, ['src/kubecode/View.tsx', 'src/kubecode/hook.ts'])
  assert.deepEqual([...usage.official.get('kubecode-count')], ['Badge'])
  assert.deepEqual([...usage.classNamed.keys()], ['kubecode-count'])
  assert.deepEqual([...usage.mentioned].sort(), ['kubecode-count', 'kubecode-mentioned'])
})
