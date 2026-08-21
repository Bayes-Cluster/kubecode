#!/usr/bin/env node
/**
 * Generates the vendored Material file-icon subset (ADR 0209).
 *
 * Reads the audited allowlist in `audit-list.json`, fetches each SVG from
 * the pinned upstream commit (cached under `upstream-cache/` so repeat runs
 * are offline), applies the pure transforms from `transforms.mjs`, and
 * writes deterministic, idempotent output:
 *
 *   - src/kubecode/icons/material/svg/<id>.svg   (canonical vendored copies)
 *   - src/kubecode/icons/material/manifest.ts    (runtime source of truth)
 *   - src/kubecode/icons/material/tokens.json    (union of used --material-* tokens)
 *
 * Only this script touches the network, and only for cache misses.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import console from 'node:console'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  namespaceIds,
  parseMaterialColors,
  renderSvg,
  stripSvgShell,
  tokenizeFills,
  toManifestEntry,
  toOpenFolder,
} from './transforms.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const cacheDir = resolve(scriptDir, 'upstream-cache')
const svgOutDir = resolve(repoRoot, 'src/kubecode/icons/material/svg')
const manifestPath = resolve(repoRoot, 'src/kubecode/icons/material/manifest.ts')
const tokensPath = resolve(repoRoot, 'src/kubecode/icons/material/tokens.json')
const rulesPath = resolve(repoRoot, 'src/kubecode/icons/material/rules.ts')

const audit = JSON.parse(await readFile(resolve(scriptDir, 'audit-list.json'), 'utf8'))
const { upstream } = audit
const rawBase = `https://raw.githubusercontent.com/${upstream.repo}/${upstream.commit}`

const colorTokens = parseMaterialColors(
  await readFile(resolve(cacheDir, 'material-colors.yml'), 'utf8'),
)
const hexAliases = new Map(
  Object.entries(audit.hexAliases ?? {}).map(([hex, token]) => [hex.toUpperCase(), token]),
)

async function fetchUpstream(relativePath) {
  const cachePath = resolve(cacheDir, relativePath.replaceAll('/', '__'))
  if (!existsSync(cachePath)) {
    const response = await fetch(`${rawBase}/${relativePath}`)
    if (!response.ok) {
      throw new Error(`fetch failed (${response.status}): ${rawBase}/${relativePath}`)
    }
    const body = await response.text()
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cachePath, body, 'utf8')
    return body
  }
  return readFile(cachePath, 'utf8')
}

/** Fetches `<id>_light.svg` or returns null when upstream has no variant. */
async function fetchLightVariant(id) {
  const cachePath = resolve(cacheDir, `icons__${id}_light.svg`)
  if (!existsSync(cachePath)) {
    const response = await fetch(`${rawBase}/icons/${id}_light.svg`)
    if (!response.ok) return null
    const body = await response.text()
    await writeFile(cachePath, body, 'utf8')
  }
  return readFile(cachePath, 'utf8')
}

function tokenize(id, source) {
  const { viewBox, body } = stripSvgShell(source)
  return {
    viewBox,
    body: namespaceIds(id, tokenizeFills(body, colorTokens, hexAliases)),
  }
}

function collectTokens(body, into) {
  for (const match of body.matchAll(/var\(--material-([a-z-]+-\w+)\)/g)) {
    into.add(match[1])
  }
}

const entries = []
const usedTokens = new Set()

for (const spec of audit.icons) {
  const dark = tokenize(spec.id, await fetchUpstream(`icons/${spec.id}.svg`))
  collectTokens(dark.body, usedTokens)
  const entry = { id: spec.id, viewBox: dark.viewBox, dark: dark.body }
  const lightSource = await fetchLightVariant(spec.id)
  if (lightSource !== null) {
    const light = tokenize(spec.id, lightSource)
    collectTokens(light.body, usedTokens)
    entry.light = light.body
  }
  entries.push(entry)
}

for (const folder of audit.folders) {
  const closed = tokenize(folder.id, await fetchUpstream(`icons/${folder.id}.svg`))
  const open = { ...closed, body: toOpenFolder(closed.body) }
  collectTokens(closed.body, usedTokens)
  collectTokens(open.body, usedTokens)
  entries.push({ id: folder.id, viewBox: closed.viewBox, dark: closed.body })
  entries.push({
    id: `${folder.id}-open`,
    viewBox: closed.viewBox,
    dark: open.body,
  })
}

for (const baseline of audit.baselines) {
  const source = await readFile(resolve(scriptDir, 'assets', `${baseline}.svg`), 'utf8')
  const { viewBox, body } = stripSvgShell(source)
  collectTokens(body, usedTokens)
  entries.push({ id: baseline, viewBox, dark: body })
}

entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

if (entries.length > audit.maxIcons) {
  throw new Error(`audit subset has ${entries.length} icons, over the ${audit.maxIcons} cap`)
}

const svgBytes = entries.reduce(
  (total, entry) =>
    total
    + Buffer.byteLength(renderSvg(entry.viewBox, entry.dark))
    + (entry.light ? Buffer.byteLength(renderSvg(entry.viewBox, entry.light)) : 0),
  0,
)
if (svgBytes > audit.maxTotalSvgBytes) {
  throw new Error(
    `audit subset is ${svgBytes} bytes of SVG, over the ${audit.maxTotalSvgBytes} budget`,
  )
}

await mkdir(svgOutDir, { recursive: true })
for (const entry of entries) {
  await writeFile(
    resolve(svgOutDir, `${entry.id}.svg`),
    `${renderSvg(entry.viewBox, entry.dark)}\n`,
    'utf8',
  )
  if (entry.light !== undefined) {
    await writeFile(
      resolve(svgOutDir, `${entry.id}_light.svg`),
      `${renderSvg(entry.viewBox, entry.light)}\n`,
      'utf8',
    )
  }
}

const manifest = `// GENERATED by scripts/material-icons/generate.mjs from
// ${upstream.repo}@${upstream.commit} (MIT). Do not edit by hand; rerun
// \`pnpm icons:material\` after changing scripts/material-icons/audit-list.json.

/** Inner markup for one vendored icon; \`light\` overrides dark themes' body in light themes. */
export type MaterialIconBody = {
  viewBox: string
  dark: string
  light?: string
}

export const MATERIAL_ICONS = {
${entries.map((entry) => toManifestEntry(entry.id, entry)).join('\n')}
} as const satisfies Record<string, MaterialIconBody>

export type MaterialIconId = keyof typeof MATERIAL_ICONS
`
await writeFile(manifestPath, manifest, 'utf8')

await writeFile(
  tokensPath,
  `${JSON.stringify({ commit: upstream.commit, tokens: [...usedTokens].sort() }, null, 2)}\n`,
  'utf8',
)

const jsonLiteral = (value) => JSON.stringify(value, null, 2)
  .replaceAll('\n', '\n  ')
  .replaceAll('}', ' }')
const rules = `// GENERATED by scripts/material-icons/generate.mjs from
// audit-list.json. Do not edit by hand; rerun \`pnpm icons:material\`.

/** Exact (case-insensitive) filename -> icon id. */
export const EXACT_FILES = ${jsonLiteral(audit.files.exact)} as const

/** Compound suffixes ordered longest-first; first match wins. */
export const COMPOUND_SUFFIXES = ${jsonLiteral(
  [...audit.files.compoundSuffixes]
    .map(({ suffix, icon }) => ({ suffix, icon }))
    .sort((a, b) => b.suffix.length - a.suffix.length),
)} as const

/** Lowercase extension (without dot) -> icon id. */
export const EXTENSIONS = ${jsonLiteral(audit.files.extensions)} as const

/** Semantic basename fallbacks (no extension) -> icon id. */
export const SEMANTIC = ${jsonLiteral(audit.files.semantic)} as const

/** Audited directory names -> folder icon id (open variants are
 * \`\${id}-open\` companions generated from the closed body). */
export const DIRECTORY_NAMES = ${jsonLiteral(
  Object.fromEntries(audit.folders.flatMap((folder) => folder.names.map((name) => [name, folder.id]))),
)} as const
`
await writeFile(rulesPath, rules, 'utf8')

console.log(
  `material-icons: ${entries.length} icons (${svgBytes} SVG bytes), ${usedTokens.size} tokens -> ${resolve(repoRoot, 'src/kubecode/icons/material')}`,
)
