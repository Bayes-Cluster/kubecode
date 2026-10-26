#!/usr/bin/env node
// ADR 0247 and ADR 0256: official components own their base appearance.
// ADR 0257: `src/components/agent-ui` is a second kind of presentation owner.
// Product CSS (every .css file under src/) may lay out the elements it owns,
// but it may not:
//   - reach into an official component's internals (`[data-slot=…]`,
//     `[cmdk-…]`, `[data-radix-…]`) or win by `!important`;
//   - repaint an official component through a class the product put on it
//     (a rule whose subject is a class that TSX passes as `className` to an
//     import from `src/components/ui` or `src/components/ai-elements`, with a
//     size, padding, border, radius, font or colour declaration);
//   - repaint an agent-ui component the same way, from any stylesheet outside
//     `src/components/agent-ui` (inside it, the layer styles its own
//     `agx-*` classes and its own subtree);
//   - reach descendant elements or roles (`… button`, `… svg`, `[role=…]`);
//   - restyle a third-party engine's internals (`.cm-`, `.xterm`,
//     `[data-streamdown]`, `.hljs-`, `.katex`, and the Sonner host's
//     `[data-sonner-*]` extension points, which only the agent-ui toaster
//     presentation may paint — through baselined rules).
// It also lists dead classes: `kubecode-*` and `agx-*` classes a TSX
// `className` uses that no rule styles, and rules whose `kubecode-*`/`agx-*`
// class no product file uses.
// Rules that predate the decision are listed, with the slice that removes
// them, in scripts/css-ownership-baseline.json. An entry is matched by file,
// enclosing selector and line text, so moving a listed declaration under
// another selector counts as new. The list only shrinks: a new violation
// fails, and so does an entry whose rule is gone.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const OFFICIAL_INTERNALS = [
  /\[data-slot=/,
  /\[cmdk-[a-z-]+/,
  /\[data-radix-[a-z-]+/,
]

const THIRD_PARTY_INTERNALS = [
  /\.cm-/,
  /\.xterm/,
  /\[data-streamdown/,
  /\.hljs(?:-|\b)/,
  /\.katex/,
  // The Sonner toast host: styled only by the agent-ui toaster presentation
  // (ADR 0257 §6), rule by rule through the baseline.
  /\[data-sonner-[a-z-]+/,
]

/** Declarations that change how an official component looks, not where it sits. */
const APPEARANCE = /^(?:color|background(?:-[a-z]+)?|border(?:-[a-z-]+)?|box-shadow|font(?:-[a-z]+)?|line-height|letter-spacing|text-transform|text-decoration(?:-[a-z]+)?|padding(?:-[a-z]+)?|height|min-height|max-height|outline(?:-[a-z]+)?|opacity)$/

/** Elements and roles a product rule may not reach through a combinator. */
const REACHED_ELEMENT = /^(?:a|button|input|textarea|select|svg|img|kbd|code|pre|p|h[1-6]|time|small|strong|label|table|thead|tbody|tr|th|td|hr)(?![\w-])/

const OFFICIAL_DIRECTORIES = ['src/components/ui', 'src/components/ai-elements']

/** ADR 0257: owned presentation layers that style their own classes. */
const PRESENTATION_DIRECTORIES = ['src/components/agent-ui']

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

/**
 * Every rule of a stylesheet (comments removed): its selector headers from the
 * outermost block in, the line its own header ends on, and its declarations.
 */
export function parseRules(source) {
  const css = stripComments(source)
  const rules = []
  const stack = []
  let buffer = ''
  let line = 1
  for (const char of css) {
    if (char === '\n') { line += 1; buffer += ' '; continue }
    if (char === '{') {
      stack.push({ header: squash(buffer), line, declarations: [] })
      buffer = ''
    } else if (char === ';') {
      const text = squash(buffer)
      const top = stack[stack.length - 1]
      if (text && top) top.declarations.push({ property: text.split(':')[0].trim().toLowerCase(), text: `${text};`, line })
      buffer = ''
    } else if (char === '}') {
      const text = squash(buffer)
      const top = stack[stack.length - 1]
      if (text && top) top.declarations.push({ property: text.split(':')[0].trim().toLowerCase(), text, line })
      buffer = ''
      const block = stack.pop()
      if (block && !block.header.startsWith('@')) {
        const path = [...stack.map((item) => item.header), block.header]
        const selectors = path.filter((header) => !header.startsWith('@'))
        rules.push({ header: block.header, selector: selectors.join(' '), path: path.join(' / '), line: block.line, declarations: block.declarations })
      }
    } else {
      buffer += char
    }
  }
  return rules
}

/** The compounds of one selector, split at combinators outside brackets. */
export function splitCompounds(selector) {
  const compounds = []
  let depth = 0
  let current = ''
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current) compounds.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) compounds.push(current)
  return compounds
}

/** The comma-separated parts of a selector list, split outside brackets. */
function splitParts(selector) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    if (depth === 0 && char === ',') { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** `min-height: 0` and `height: 100%` make a flex child scroll or fill; they size nothing. */
const isLayoutSize = ({ property, text }) =>
  /^(?:min-|max-)?height$/.test(property) && /:\s*(?:0|100%|100(?:d)?vh|auto|inherit)\s*;?$/.test(text)

const classesOf = (compound) => [...compound.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1])

function reachesElement(compound) {
  if (REACHED_ELEMENT.test(compound) || /\[role=/.test(compound)) return true
  const inner = compound.match(/:(?:is|where)\(([^)]*)\)/)
  return Boolean(inner && splitParts(inner[1]).some((part) => REACHED_ELEMENT.test(part.trim())))
}

/** Lines of a stylesheet that target official or third-party internals or force with !important. */
export function findViolations(source) {
  const css = stripComments(source)
  const contexts = lineContexts(css)
  const violations = []
  css.split('\n').forEach((line, index) => {
    const text = line.trim()
    if (!text) return
    const internal = OFFICIAL_INTERNALS.some((pattern) => pattern.test(text))
    const thirdParty = !internal && THIRD_PARTY_INTERNALS.some((pattern) => pattern.test(text))
    const important = /!important/.test(text)
    if (internal || thirdParty || important) {
      const kind = internal ? 'official-internal' : thirdParty ? 'third-party-internal' : 'important'
      violations.push({ line: index + 1, text, context: contexts[index] ?? '', kind })
    }
  })
  return violations
}

/**
 * Rules of a stylesheet that reach descendant elements or roles through a
 * combinator (`.kubecode-x button`, `.kubecode-y [role=tree]`).
 */
export function findReachIns(source) {
  return parseRules(source)
    .filter((rule) => splitParts(rule.selector).some((part) => splitCompounds(part).slice(1).some(reachesElement)))
    .map((rule) => ({ line: rule.line, text: rule.header, context: rule.path, kind: 'element-reach-in' }))
}

/**
 * Declarations that repaint an official component: the rule's subject is a
 * class TSX passes as `className` to an official import, and the declaration
 * sets size, padding, border, radius, font or colour.
 */
export function findAppearanceOnOfficial(source, officialClasses) {
  const violations = []
  for (const rule of parseRules(source)) {
    const subjects = splitParts(rule.selector).flatMap((part) => classesOf(splitCompounds(part).at(-1) ?? ''))
    const hits = subjects.filter((name) => officialClasses.has(name))
    if (hits.length === 0) continue
    for (const declaration of rule.declarations) {
      if (!APPEARANCE.test(declaration.property) || isLayoutSize(declaration)) continue
      violations.push({ line: declaration.line, text: declaration.text, context: rule.path, kind: 'appearance-on-official', component: [...new Set(hits.flatMap((name) => [...officialClasses.get(name)]))].join(', ') })
    }
  }
  return violations
}

/**
 * Declarations that repaint an agent-ui component: the rule's subject is a
 * class TSX passes as `className` to an agent-ui import, or any `agx-*`
 * class — the prefix is the layer's namespace, so a foreign stylesheet
 * painting it is a repaint even when no TSX mapping saw it. Only meaningful
 * for stylesheets outside the presentation directory itself.
 */
export function findAppearanceOnPresentation(source, presentationClasses) {
  const violations = []
  for (const rule of parseRules(source)) {
    const subjects = splitParts(rule.selector).flatMap((part) => classesOf(splitCompounds(part).at(-1) ?? ''))
    const hits = subjects.filter((name) => presentationClasses.has(name) || name.startsWith('agx-'))
    if (hits.length === 0) continue
    for (const declaration of rule.declarations) {
      if (!APPEARANCE.test(declaration.property) || isLayoutSize(declaration)) continue
      const components = [
        ...new Set(hits.flatMap((name) => [...(presentationClasses.get(name) ?? ['agent-ui (agx-*)'])])),
      ]
      violations.push({ line: declaration.line, text: declaration.text, context: rule.path, kind: 'appearance-on-agent-ui', component: components.join(', ') })
    }
  }
  return violations
}

/** Rules whose `kubecode-*` or `agx-*` class no product source uses. */
export function findDeadRules(source, usedClasses) {
  const violations = []
  for (const rule of parseRules(source)) {
    const classes = new Set(splitParts(rule.selector).flatMap((part) => classesOf(part)).filter(isOwnedName))
    for (const name of classes) {
      if (!usedClasses.has(name)) violations.push({ line: rule.line, text: `.${name}`, context: rule.path, kind: 'dead-rule' })
    }
  }
  return violations
}

const isOwnedName = (name) => name.startsWith('kubecode-') || name.startsWith('agx-')

const IMPORT = /import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g

/** Local names of the components a source file imports from `directories`. */
export function officialImports(source, file, root, directories = OFFICIAL_DIRECTORIES) {
  const names = new Set()
  for (const match of source.matchAll(IMPORT)) {
    const [, defaultName, named, from] = match
    const path = from.startsWith('@/')
      ? `src/${from.slice(2)}`
      : from.startsWith('.')
        ? relative(root, resolve(dirname(join(root, file)), from))
        : null
    if (!path || !directories.some((directory) => path === directory || path.startsWith(`${directory}/`))) continue
    if (defaultName) names.add(defaultName)
    for (const item of (named ?? '').split(',')) {
      const name = item.trim()
      // A type-only specifier is not a component.
      if (!name || /^type\s/.test(name)) continue
      names.add(name.includes(' as ') ? name.split(' as ')[1].trim() : name)
    }
  }
  return names
}

/** Every JSX element with a className: its tag, the class tokens and the line. */
export function classNameUses(source) {
  const uses = []
  const tag = /<([A-Za-z][\w.]*)(?=[\s/>])/g
  for (const match of source.matchAll(tag)) {
    let index = match.index + match[0].length
    let depth = 0
    let quote = null
    let attributes = ''
    while (index < source.length) {
      const char = source[index]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'" || char === '`') quote = char
      else if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) break
      attributes += char
      index += 1
    }
    const attribute = /className\s*=\s*(?:(["'])([^"']*)\1|\{)/.exec(attributes)
    if (!attribute) continue
    let literal = attribute[2]
    if (literal === undefined) {
      // An expression: every string literal inside it.
      let start = attribute.index + attribute[0].length
      let nested = 1
      let end = start
      while (end < attributes.length && nested > 0) {
        if (attributes[end] === '{') nested += 1
        else if (attributes[end] === '}') nested -= 1
        end += 1
      }
      literal = [...attributes.slice(start, end - 1).matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((item) => item[2]).join(' ')
    }
    const classes = literal.split(/\s+/).filter((token) => /^[A-Za-z_][\w-]*$/.test(token))
    if (classes.length === 0) continue
    const line = source.slice(0, match.index).split('\n').length
    uses.push({ tag: match[1], classes, line })
  }
  return uses
}

/** Every file with one of the extensions under a directory, relative to root, sorted. */
export function listFiles(root, directory, extensions) {
  const found = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isDirectory()) walk(path)
      else if (extensions.some((extension) => item.name.endsWith(extension))) found.push(relative(root, path))
    }
  }
  walk(join(root, directory))
  return found.sort()
}

/** Every .css file under a directory, relative to root, sorted. */
export function listStylesheets(root, directory) {
  return listFiles(root, directory, ['.css'])
}

const isTest = (file) => /\.(test|spec)\.[jt]sx?$/.test(file) || file.startsWith('src/test/')

/**
 * What the product's TSX says about classes: which classes sit on official
 * components (class → component names), which sit on agent-ui components
 * (class → component names), which `kubecode-*`/`agx-*` classes a className
 * uses (class → first file and line), and every owned token any product
 * source mentions.
 */
export function collectClassUsage(root, files) {
  const official = new Map()
  const presentation = new Map()
  const classNamed = new Map()
  const mentioned = new Set()
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const token of source.matchAll(/(?<![\w-])(?:kubecode-|agx-)[\w-]+/g)) mentioned.add(token[0])
    if (!file.endsWith('.tsx')) continue
    const imports = officialImports(source, file, root)
    const presentationImports = officialImports(source, file, root, PRESENTATION_DIRECTORIES)
    for (const use of classNameUses(source)) {
      for (const name of use.classes) {
        if (imports.has(use.tag)) {
          if (!official.has(name)) official.set(name, new Set())
          official.get(name).add(use.tag)
        }
        if (presentationImports.has(use.tag)) {
          if (!presentation.has(name)) presentation.set(name, new Set())
          presentation.get(name).add(use.tag)
        }
        if (isOwnedName(name) && !classNamed.has(name)) classNamed.set(name, { file, line: use.line })
      }
    }
  }
  return { official, presentation, classNamed, mentioned }
}

/** `kubecode-*`/`agx-*` classes a TSX className uses that no stylesheet styles. */
export function findDeadClasses(classNamed, stylesheets) {
  const styled = new Set()
  for (const css of stylesheets) {
    for (const rule of parseRules(css)) for (const name of classesOf(rule.selector)) styled.add(name)
  }
  return [...classNamed.entries()]
    .filter(([name]) => !styled.has(name))
    .map(([name, { file, line }]) => ({ file, line, text: name, context: '', kind: 'dead-class' }))
}

/** Every violation across the product: stylesheets against the TSX that uses them. */
export function findAllViolations(root) {
  const stylesheets = listStylesheets(root, 'src')
  const sources = listFiles(root, 'src', ['.ts', '.tsx']).filter((file) => !isTest(file))
  const usage = collectClassUsage(root, sources)
  const violations = []
  const cssSources = []
  for (const file of stylesheets) {
    const css = readFileSync(join(root, file), 'utf8')
    cssSources.push(css)
    // Inside a presentation directory the layer styles its own classes and
    // its own subtree — reaching its own elements is what owning the
    // presentation means (ADR 0257 §6). The rules that protect someone
    // else's CSS still apply there.
    const ownedStyles = PRESENTATION_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`))
    const found = [
      ...findViolations(css),
      ...(ownedStyles ? [] : findReachIns(css)),
      ...findAppearanceOnOfficial(css, usage.official),
      ...(ownedStyles ? [] : findAppearanceOnPresentation(css, usage.presentation)),
      ...findDeadRules(css, usage.mentioned),
    ]
    violations.push(...found.map((violation) => ({ file, ...violation })))
  }
  violations.push(...findDeadClasses(usage.classNamed, cssSources))
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

const here = dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const root = join(here, '..')
  const baselinePath = join(here, 'css-ownership-baseline.json')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).entries
  const violations = findAllViolations(root)
  if (process.argv.includes('--write-baseline')) {
    const owners = new Map(baseline.map((entry) => [keyOf(entry), entry.owner]))
    const entries = violations.map(({ file, text, context, kind, component }) => ({
      file, text, context, kind, ...(component ? { component } : {}), owner: owners.get(keyOf({ file, context, text })) ?? 'unassigned (#276, a later slice)',
    }))
    writeFileSync(baselinePath, `${JSON.stringify({ entries }, null, 2)}\n`)
    const counts = {}
    for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    console.log(`CSS ownership baseline: ${entries.length} entries ${JSON.stringify(counts)}`)
    process.exit(0)
  }
  const { added, stale } = compareWithBaseline(violations, baseline)
  for (const violation of added) {
    console.error(`${violation.file}:${violation.line} ${violation.kind}: ${violation.text}${violation.component ? ` (on ${violation.component})` : ''}${violation.context ? ` (in ${violation.context})` : ''}`)
  }
  for (const entry of stale) console.error(`scripts/css-ownership-baseline.json: stale entry, remove it: ${entry.file} ${entry.kind} ${entry.text}${entry.context ? ` (in ${entry.context})` : ''}`)
  if (added.length || stale.length) {
    console.error('CSS ownership check failed (ADR 0247, ADR 0256, ADR 0257, docs/design/ui-shared-contract.md).')
    process.exit(1)
  }
  const counts = {}
  for (const violation of violations) counts[violation.kind] = (counts[violation.kind] ?? 0) + 1
  console.log(`CSS ownership: ${violations.length} listed legacy findings ${JSON.stringify(counts)}, no new ones.`)
}
