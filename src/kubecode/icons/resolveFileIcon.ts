/**
 * Pure filename -> vendored Material icon resolution (ADR 0209).
 *
 * Files: exact filename -> longest compound suffix -> extension -> semantic
 * fallback -> generic 'file'. Directories: audited name -> '-open'
 * companion when expanded -> generic 'folder'/'folder-open'. All matching
 * is case-insensitive.
 */

import type { MaterialIconId } from './material/manifest'
import { COMPOUND_SUFFIXES, DIRECTORY_NAMES, EXACT_FILES, EXTENSIONS, SEMANTIC } from './material/rules'

const EXACT_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(EXACT_FILES).map(([name, icon]) => [name.toLowerCase(), icon]),
)

const SUFFIXES_BY_LENGTH: readonly { suffix: string; icon: string }[] = [...COMPOUND_SUFFIXES]

const ICON_BY_EXTENSION: ReadonlyMap<string, string> = new Map(
  Object.entries(EXTENSIONS).map(([ext, icon]) => [ext.toLowerCase(), icon]),
)

const ICON_BY_SEMANTIC: ReadonlyMap<string, string> = new Map(
  Object.entries(SEMANTIC).map(([stem, icon]) => [stem.toLowerCase(), icon]),
)

const FOLDER_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(DIRECTORY_NAMES).map(([name, id]) => [name.toLowerCase(), id]),
)

function toIconId(icon: string): MaterialIconId {
  return icon as MaterialIconId
}

/**
 * Resolves the audited Material icon id for a file name or relative path.
 * Path separators are stripped first so exact-filename rules (package.json,
 * README.md, ...) still hit when callers pass `src/package.json`.
 */
export function resolveFileIcon(name: string): MaterialIconId {
  const base = name.trim().toLowerCase().split(/[\\/]/).pop() ?? ''
  const lower = base
  if (lower === '') return 'file'

  const exact = EXACT_BY_NAME.get(lower)
  if (exact !== undefined) return toIconId(exact)

  for (const { suffix, icon } of SUFFIXES_BY_LENGTH) {
    if (lower.endsWith(suffix)) return toIconId(icon)
  }

  const extension = lower.slice(lower.lastIndexOf('.') + 1)
  if (extension !== lower) {
    const byExtension = ICON_BY_EXTENSION.get(extension)
    if (byExtension !== undefined) return toIconId(byExtension)
  }

  const stem = lower.replace(/\.[^.]*$/, '')
  const semantic = ICON_BY_SEMANTIC.get(stem)
  if (semantic !== undefined) return toIconId(semantic)

  return 'file'
}

/** Resolves the audited Material icon id for a directory, honoring expansion. */
export function resolveDirectoryIcon(name: string, expanded = false): MaterialIconId {
  const lower = name.trim().toLowerCase()
  if (lower === '') return expanded ? 'folder-open' : 'folder'
  const named = FOLDER_BY_NAME.get(lower)
  if (named !== undefined) {
    return toIconId(expanded ? `${named}-open` : named)
  }
  return expanded ? 'folder-open' : 'folder'
}
