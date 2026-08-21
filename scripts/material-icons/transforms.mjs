/**
 * Pure transforms for the vendored Material icon subset (ADR 0209).
 *
 * Everything here is synchronous and offline: the generator fetches the
 * pinned upstream SVGs, these functions strip the `<svg>` shell, rewrite
 * upstream hex fills to `--material-*` tokens, and derive open-folder
 * variants using the transform ported from upstream's
 * `src/scripts/svg/generateOpenFolderIcons.ts`.
 */

/** Canonical 16x16 open folder path (ported verbatim from upstream). */
export const OPEN_FOLDER_PATH =
  'M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6'

const SVG_TAG_PATTERN = /^<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/

/**
 * Parses `material-colors.yml` into a hex -> token-name map, e.g.
 * `#42A5F5` -> `blue-400`. Comment form: `- '#FFEBEE' # red 50`.
 */
export function parseMaterialColors(yamlText) {
  const colors = new Map()
  const linePattern = /^\s*-\s+'#([0-9a-fA-F]{6})'\s*#\s*([a-z]+(?:\s+[a-z]+)*)\s+([0-9A-Z]+)\s*$/
  for (const line of yamlText.split(/\r?\n/)) {
    const match = linePattern.exec(line)
    if (!match) continue
    const [, hex, name, shade] = match
    colors.set(hex.toUpperCase(), `${name.replaceAll(' ', '-')}-${shade}`)
  }
  return colors
}

/**
 * Strips the outer `<svg>` shell and returns `{ viewBox, body }` where
 * `body` is the inner markup. Throws when the shell is malformed.
 */
export function stripSvgShell(source) {
  const trimmed = source.trim()
  const match = SVG_TAG_PATTERN.exec(trimmed)
  if (!match) {
    throw new Error('icon SVG must be a single <svg> element')
  }
  const viewBox = /viewBox="([^"]+)"/.exec(trimmed)?.[1]
  if (!viewBox) {
    throw new Error('icon SVG is missing its viewBox')
  }
  return { viewBox, body: match[1] }
}

/**
 * Rewrites every `fill="#RRGGBB"` (or 3-digit shorthand) in `body` to
 * `fill="var(--material-<name>-<shade>)"`. Unknown hex values are a hard
 * error unless audited in `hexAliases` (hex -> token name).
 */
export function tokenizeFills(body, colorTokens, hexAliases = new Map()) {
  const problems = []
  const rewritten = body.replace(
    /(fill|stop-color)="#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})"/g,
    (whole, attribute, hex) => {
    const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
    const key = expanded.toUpperCase()
    const token = colorTokens.get(key) ?? hexAliases.get(key)
    if (!token) {
      problems.push(key)
      return whole
    }
    return `${attribute}="var(--material-${token})"`
    },
  )
  if (problems.length > 0) {
    throw new Error(
      `unknown upstream hex fill(s): ${[...new Set(problems)].join(', ')}; add them to audit-list.json hexAliases`,
    )
  }
  return rewritten
}

/**
 * Replaces the `d` attribute of the path with `id="folder"` (the closed
 * folder silhouette) with the canonical open-folder path. Ported from
 * upstream `generateOpenFolderIcons.ts`.
 */
export function toOpenFolder(body) {
  const pattern = /(<path\b[^>]*\bid="folder"[^>]*?)d="[^"]*"/
  if (!pattern.test(body)) {
    throw new Error('folder body has no path with id="folder"')
  }
  return body.replace(pattern, (whole, prefix) => `${prefix}d="${OPEN_FOLDER_PATH}"`)
}

/**
 * Prefixes `id="..."` and `url(#...)` references with the icon id so
 * several inlined icons cannot cross-reference each other's `<defs>`
 * through duplicate DOM ids (e.g. upstream kotlin's gradient `id="a"`).
 */
export function namespaceIds(id, body) {
  let namespaced = body
  const rawIds = new Set()
  for (const match of body.matchAll(/url\(#([a-zA-Z0-9_-]+)\)/g)) {
    rawIds.add(match[1])
  }
  for (const raw of rawIds) {
    namespaced = namespaced
      .replaceAll(`id="${raw}"`, `id="material-${id}-${raw}"`)
      .replaceAll(`url(#${raw})`, `url(#material-${id}-${raw})`)
  }
  return namespaced
}

/** Renders a stable outer `<svg>` with tokenized inner markup. */
export function renderSvg(viewBox, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`
}

/**
 * Deterministic manifest entry serialization: keys in a fixed order so
 * regeneration is byte-for-byte idempotent.
 */
export function toManifestEntry(id, { viewBox, dark, light = undefined }) {
  const lines = [
    `  '${id}': {`,
    `    viewBox: '${viewBox}',`,
    `    dark: ${JSON.stringify(dark)},`,
  ]
  if (light !== undefined) {
    lines.push(`    light: ${JSON.stringify(light)},`)
  }
  lines.push('  },')
  return lines.join('\n')
}
