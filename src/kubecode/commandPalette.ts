import type { AgentId, ComposerCatalogItem, ComposerCatalogSnapshot } from './api'
import { rankComposerCapabilities } from './composerCapabilities'
import { fuzzyMatchRank } from './fuzzyMatch'

export type RankedCommandPaletteItem = ComposerCatalogItem & {
  catalogRevision: number
}

export type CommandPaletteSessionSnapshot = {
  agentId: AgentId | null
  catalog: ComposerCatalogSnapshot | null
  catalogStatus: 'error' | 'loading' | 'ready'
  conversationId: string | null
  execute: (item: RankedCommandPaletteItem) => Promise<boolean>
  projectId: string | null
  writable: boolean
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

const COMMAND_PALETTE_MATCH_WEIGHTS = {
  empty: 5,
  exact: 0,
  prefix: 1,
  secondary: 4,
  subsequence: 3,
  substring: 2,
} as const

export function commandPaletteMatchRank(
  name: string,
  description: string | null,
  query: string,
): number | null {
  const normalizedQuery = normalized(query.trim())
  return fuzzyMatchRank(normalizedQuery, {
    primary: [normalized(name)],
    secondary: [normalized(description ?? '')],
  }, COMMAND_PALETTE_MATCH_WEIGHTS)
}

export function commandPaletteCatalogGroups(
  catalog: ComposerCatalogSnapshot | null | undefined,
  query: string,
): {
  capabilities: RankedCommandPaletteItem[]
  commands: RankedCommandPaletteItem[]
  pluginActions: RankedCommandPaletteItem[]
} {
  if (!catalog) return { capabilities: [], commands: [], pluginActions: [] }
  const commands = catalog.items
    .flatMap((item, index) => {
      if (item.kind !== 'command') return []
      const rank = commandPaletteMatchRank(item.name, item.description, query)
      return rank === null ? [] : [{ index, item, rank }]
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => ({ ...item, catalogRevision: catalog.revision }))
  const rankedCapabilities = rankComposerCapabilities(catalog, query)
  return {
    commands,
    capabilities: rankedCapabilities.filter((item) => item.kind !== 'plugin_action'),
    pluginActions: rankedCapabilities.filter((item) => item.kind === 'plugin_action'),
  }
}

export function isGlobalCommandPaletteShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = globalThis.navigator?.platform ?? '',
): boolean {
  if (event.altKey || !event.shiftKey || event.key.toLocaleLowerCase() !== 'p') return false
  const macOS = /mac|iphone|ipad|ipod/i.test(platform)
  return macOS
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}
