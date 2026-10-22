#!/usr/bin/env node
// ADR 0247: official components own their base appearance. Product CSS
// (src/kubecode/kubecode.css) may lay out the elements it owns, but it may not
// reach into an official component's internals (`[data-slot=…]`, the
// component's own classes) or win by `!important`. Rules that predate the
// decision are listed, with the slice that removes them, in
// scripts/css-ownership-baseline.json. The list only shrinks: a new violation
// fails, and so does an entry whose rule is gone (remove it from the list).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OFFICIAL_INTERNALS = [
  /\[data-slot=/,
  /\[cmdk-[a-z-]+/,
  /\[data-radix-[a-z-]+/,
]

/** Lines of the stylesheet that target official internals or force with !important. */
export function findViolations(css) {
  const violations = []
  css.split('\n').forEach((line, index) => {
    const text = line.trim()
    if (!text || text.startsWith('/*') || text.startsWith('*')) return
    const internal = OFFICIAL_INTERNALS.some((pattern) => pattern.test(text))
    const important = /!important/.test(text)
    if (internal || important) violations.push({ line: index + 1, text, kind: internal ? 'official-internal' : 'important' })
  })
  return violations
}

/** Compares violations with the baseline: new ones and stale entries both fail. */
export function compareWithBaseline(violations, baseline) {
  const remaining = new Map()
  for (const entry of baseline) remaining.set(entry.text, (remaining.get(entry.text) ?? 0) + 1)
  const added = []
  for (const violation of violations) {
    const count = remaining.get(violation.text) ?? 0
    if (count > 0) remaining.set(violation.text, count - 1)
    else added.push(violation)
  }
  const stale = [...remaining.entries()].filter(([, count]) => count > 0).map(([text]) => text)
  return { added, stale }
}

const here = dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const root = join(here, '..')
  const css = readFileSync(join(root, 'src/kubecode/kubecode.css'), 'utf8')
  const baselinePath = join(here, 'css-ownership-baseline.json')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).entries
  const violations = findViolations(css)
  if (process.argv.includes('--write-baseline')) {
    const known = new Map(baseline.map((entry) => [entry.text, entry]))
    const entries = violations.map(({ text, kind }) => ({ owner: 'unassigned', ...known.get(text), text, kind }))
    writeFileSync(baselinePath, `${JSON.stringify({ entries }, null, 2)}\n`)
    process.exit(0)
  }
  const { added, stale } = compareWithBaseline(violations, baseline)
  for (const violation of added) {
    console.error(`src/kubecode/kubecode.css:${violation.line} ${violation.kind}: ${violation.text}`)
  }
  for (const text of stale) console.error(`scripts/css-ownership-baseline.json: stale entry, remove it: ${text}`)
  if (added.length || stale.length) {
    console.error('CSS ownership check failed (ADR 0247, docs/design/ui-shared-contract.md).')
    process.exit(1)
  }
  console.log(`CSS ownership: ${violations.length} listed legacy rules, no new ones.`)
}
