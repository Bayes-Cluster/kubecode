#!/usr/bin/env node
// ADR 0247: official components own their base appearance. Product CSS (every
// .css file under src/) may lay out the elements it owns, but it may not reach
// into an official component's internals (`[data-slot=…]`, the component's own
// classes) or win by `!important`. Rules that predate the decision are listed,
// with the slice that removes them, in scripts/css-ownership-baseline.json.
// An entry is matched by file, enclosing selector and line text, so moving a
// listed declaration under another selector counts as new. The list only
// shrinks: a new violation fails, and so does an entry whose rule is gone.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const OFFICIAL_INTERNALS = [
  /\[data-slot=/,
  /\[cmdk-[a-z-]+/,
  /\[data-radix-[a-z-]+/,
]

const squash = (text) => text.replace(/\s+/g, ' ').trim()

/** Replaces comments with spaces, keeping line breaks so line numbers hold. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

/** For each line, the selector path of the rule it belongs to. */
function lineContexts(css) {
  const contexts = []
  const stack = []
  let buffer = ''
  let bufferLines = new Set()
  let line = 0
  const assign = (path) => {
    for (const index of bufferLines) if (contexts[index] === undefined) contexts[index] = path
    buffer = ''
    bufferLines = new Set()
  }
  for (const char of css) {
    if (char === '\n') { line += 1; buffer += ' '; continue }
    if (char === '{') {
      const header = squash(buffer)
      bufferLines.add(line)
      assign([...stack, header].join(' / '))
      stack.push(header)
    } else if (char === ';') {
      bufferLines.add(line)
      assign(stack.join(' / '))
    } else if (char === '}') {
      bufferLines.add(line)
      assign(stack.join(' / '))
      stack.pop()
    } else {
      buffer += char
      if (!/\s/.test(char)) bufferLines.add(line)
    }
  }
  assign(stack.join(' / '))
  return contexts
}

/** Lines of a stylesheet that target official internals or force with !important. */
export function findViolations(source) {
  const css = stripComments(source)
  const contexts = lineContexts(css)
  const violations = []
  css.split('\n').forEach((line, index) => {
    const text = line.trim()
    if (!text) return
    const internal = OFFICIAL_INTERNALS.some((pattern) => pattern.test(text))
    const important = /!important/.test(text)
    if (internal || important) {
      violations.push({ line: index + 1, text, context: contexts[index] ?? '', kind: internal ? 'official-internal' : 'important' })
    }
  })
  return violations
}

const keyOf = (entry) => `${entry.file ?? ''}\u0000${entry.context ?? ''}\u0000${entry.text}`

/** Compares violations with the baseline: new ones and stale entries both fail. */
export function compareWithBaseline(violations, baseline) {
  const remaining = new Map()
  for (const entry of baseline) remaining.set(keyOf(entry), { entry, count: (remaining.get(keyOf(entry))?.count ?? 0) + 1 })
  const added = []
  for (const violation of violations) {
    const known = remaining.get(keyOf(violation))
    if (known && known.count > 0) known.count -= 1
    else added.push(violation)
  }
  const stale = [...remaining.values()].filter(({ count }) => count > 0).map(({ entry }) => entry)
  return { added, stale }
}

/** Every .css file under a directory, relative to root, sorted. */
export function listStylesheets(root, directory) {
  const found = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isDirectory()) walk(path)
      else if (item.name.endsWith('.css')) found.push(relative(root, path))
    }
  }
  walk(join(root, directory))
  return found.sort()
}

const here = dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const root = join(here, '..')
  const baselinePath = join(here, 'css-ownership-baseline.json')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).entries
  const violations = listStylesheets(root, 'src').flatMap((file) =>
    findViolations(readFileSync(join(root, file), 'utf8')).map((violation) => ({ file, ...violation })),
  )
  if (process.argv.includes('--write-baseline')) {
    const owners = new Map(baseline.map((entry) => [`${entry.file ?? 'src/kubecode/kubecode.css'}\u0000${entry.text}`, entry.owner]))
    const entries = violations.map(({ file, text, context, kind }) => ({
      file, text, context, kind, owner: owners.get(`${file}\u0000${text}`) ?? 'unassigned',
    }))
    writeFileSync(baselinePath, `${JSON.stringify({ entries }, null, 2)}\n`)
    process.exit(0)
  }
  const { added, stale } = compareWithBaseline(violations, baseline)
  for (const violation of added) {
    console.error(`${violation.file}:${violation.line} ${violation.kind}: ${violation.text} (in ${violation.context})`)
  }
  for (const entry of stale) console.error(`scripts/css-ownership-baseline.json: stale entry, remove it: ${entry.file} ${entry.text} (in ${entry.context})`)
  if (added.length || stale.length) {
    console.error('CSS ownership check failed (ADR 0247, docs/design/ui-shared-contract.md).')
    process.exit(1)
  }
  console.log(`CSS ownership: ${violations.length} listed legacy rules, no new ones.`)
}
