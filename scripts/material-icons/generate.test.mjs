import { strict as assert } from 'node:assert'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  namespaceIds,
  OPEN_FOLDER_PATH,
  parseMaterialColors,
  renderSvg,
  stripSvgShell,
  toManifestEntry,
  toOpenFolder,
  tokenizeFills,
} from './transforms.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const materialDir = resolve(repoRoot, 'src/kubecode/icons/material')

test('parses material colors including two-word names', () => {
  const yaml = [
    "# comment",
    "colors:",
    "  - '#FFEBEE' # red 50",
    "  - '#0288D1' # light blue 700",
    "  - '#42A5F5' # blue 400",
    "",
  ].join('\n')
  const tokens = parseMaterialColors(yaml)
  assert.equal(tokens.get('FFEBEE'), 'red-50')
  assert.equal(tokens.get('0288D1'), 'light-blue-700')
  assert.equal(tokens.get('42A5F5'), 'blue-400')
})

test('stripSvgShell extracts viewBox and inner markup', () => {
  const { viewBox, body } = stripSvgShell(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#42A5F5" d="M1 1"/></svg>\n',
  )
  assert.equal(viewBox, '0 0 32 32')
  assert.equal(body, '<path fill="#42A5F5" d="M1 1"/>')
})

test('stripSvgShell rejects non-svg or multi-element sources', () => {
  assert.throws(() => stripSvgShell('<span>x</span>'))
  assert.throws(() => stripSvgShell('<svg viewBox="0 0 32 32">'))
  assert.throws(() => stripSvgShell('<svg><path d="M1"/></svg>'))
})

test('tokenizeFills rewrites known fills and expands 3-digit shorthand', () => {
  const palette = new Map([
    ['42A5F5', 'blue-400'],
    ['AA00FF', 'purple-A700'],
  ])
  const rewritten = tokenizeFills(
    '<path fill="#42a5f5" d="M1"/><stop stop-color="#a0f"/>',
    palette,
  )
  assert.equal(
    rewritten,
    '<path fill="var(--material-blue-400)" d="M1"/><stop stop-color="var(--material-purple-A700)"/>',
  )

  assert.throws(
    () => tokenizeFills('<path fill="#111111"/><path fill="#222222"/>', palette),
    (error) => error.message.includes('111111') && error.message.includes('222222'),
  )
})

test('tokenizeFills honors audited hex aliases', () => {
  const palette = new Map()
  const aliases = new Map([['41B883', 'vue-green']])
  const rewritten = tokenizeFills('<path fill="#41b883"/>', palette, aliases)
  assert.equal(rewritten, '<path fill="var(--material-vue-green)"/>')
})

test('toOpenFolder swaps the id="folder" path for the canonical open path', () => {
  const closed =
    '<path id="folder" fill="var(--material-blue-400)" d="m6.9 3.7z"/><path id="motive" fill="var(--material-green-100)" d="M9 15z"/>'
  const open = toOpenFolder(closed)
  assert.ok(open.includes(`d="${OPEN_FOLDER_PATH}"`))
  assert.ok(!open.includes('m6.9 3.7z'))
  assert.ok(open.includes('id="motive"'))
})

test('toOpenFolder fails without a folder path', () => {
  assert.throws(() => toOpenFolder('<path id="motive" d="M1"/>'))
})

test('namespaceIds renames only url-referenced ids', () => {
  const gradient =
    '<defs><linearGradient id="a"><stop stop-color="#7c4dff"/></linearGradient></defs><path fill="url(#a)"/>'
  const namespaced = namespaceIds('kotlin', gradient)
  assert.ok(namespaced.includes('id="material-kotlin-a"'))
  assert.ok(namespaced.includes('url(#material-kotlin-a)'))

  const folder = '<path id="folder" d="M1"/><path id="motive" d="M2"/>'
  assert.equal(namespaceIds('folder-src', folder), folder)
})

test('renderSvg and toManifestEntry serialize deterministically'
, () => {
  assert.equal(
    renderSvg('0 0 16 16', '<path/>'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path/></svg>',
  )
  assert.equal(
    toManifestEntry('x', { viewBox: '0 0 16 16', dark: '<path/>' }),
    ["  'x': {", "    viewBox: '0 0 16 16',", '    dark: "<path/>",', '  },'].join('\n'),
  )
})

test('committed manifest matches committed svg files one-to-one', async () => {
  const manifest = await readFile(resolve(materialDir, 'manifest.ts'), 'utf8')
  const ids = [...manifest.matchAll(/^  '([a-z0-9_-]+)': \{$/gm)].map((m) => m[1])
  const svgFiles = (await readdir(resolve(materialDir, 'svg')))
    .filter((name) => name.endsWith('.svg'))
    .map((name) => name.replace(/\.svg$/, '').replace(/_light$/, ''))

  assert.ok(ids.length > 0, 'manifest should not be empty')
  assert.deepEqual([...ids].sort(), [...new Set(svgFiles)].sort())
  for (const id of ids) {
    const closed = await readFile(resolve(materialDir, 'svg', `${id}.svg`), 'utf8')
    assert.equal(closed.trim().startsWith('<svg'), true, `${id}.svg must be a root svg`)
    assert.equal(closed.includes('var(--material-'), true, `${id}.svg must use material tokens`)
  }
})

test('committed subset stays within the audited caps', async () => {
  const audit = JSON.parse(await readFile(resolve(here, 'audit-list.json'), 'utf8'))
  const manifest = await readFile(resolve(materialDir, 'manifest.ts'), 'utf8')
  const ids = [...manifest.matchAll(/^  '([a-z0-9_-]+)': \{$/gm)].map((m) => m[1])
  assert.ok(ids.length <= audit.maxIcons, `${ids.length} icons over cap ${audit.maxIcons}`)

  const svgFiles = await readdir(resolve(materialDir, 'svg'))
  const bytes = (
    await Promise.all(
      svgFiles.map((name) => readFile(resolve(materialDir, 'svg', name))),
    )
  ).reduce((total, buffer) => total + buffer.byteLength, 0)
  assert.ok(bytes <= audit.maxTotalSvgBytes, `${bytes} bytes over budget`)
})

test('committed tokens.json covers exactly the tokens used by the manifest', async () => {
  const manifest = await readFile(resolve(materialDir, 'manifest.ts'), 'utf8')
  const { tokens } = JSON.parse(await readFile(resolve(materialDir, 'tokens.json'), 'utf8'))
  const used = new Set(
    [...manifest.matchAll(/var\(--material-([a-z-]+-\w+)\)/g)].map((m) => m[1]),
  )
  assert.deepEqual([...used].sort(), [...tokens].sort())
})

test('every audited resolution target exists in the manifest', async () => {
  const manifest = await readFile(resolve(materialDir, 'manifest.ts'), 'utf8')
  const ids = new Set([...manifest.matchAll(/^  '([a-z0-9_-]+)': \{$/gm)].map((m) => m[1]))
  const audit = JSON.parse(await readFile(resolve(here, 'audit-list.json'), 'utf8'))
  const targets = new Set(audit.baselines)
  for (const spec of audit.icons) targets.add(spec.id)
  for (const folder of audit.folders) {
    targets.add(folder.id)
    targets.add(`${folder.id}-open`)
  }
  for (const icon of Object.values(audit.files.exact)) targets.add(icon)
  for (const { icon } of audit.files.compoundSuffixes) targets.add(icon)
  for (const icon of Object.values(audit.files.extensions)) targets.add(icon)
  for (const icon of Object.values(audit.files.semantic)) targets.add(icon)
  for (const target of targets) {
    assert.ok(ids.has(target), `audit target '${target}' missing from manifest`)
  }
})
