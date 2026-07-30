import type { ComposerCatalogItem, ComposerCatalogSnapshot } from './api'

export {
  findActiveComposerCapabilityQuery,
  replaceActiveComposerCapabilityQuery,
} from '@/components/inlineCapabilityQuery'

export type ComposerCapabilityKind = Exclude<ComposerCatalogItem['kind'], 'command'>
type ComposerCapabilityItem = Omit<ComposerCatalogItem, 'kind'> & { kind: ComposerCapabilityKind }

const SCOPE_ORDER: Record<ComposerCatalogItem['scope'], number> = {
  session: 0,
  project: 1,
  user: 2,
  bundled: 3,
  plugin: 4,
}

const KIND_ORDER: Record<ComposerCapabilityKind, number> = {
  skill: 0,
  plugin_action: 1,
  provider_app: 2,
}

export type RankedComposerCapability = ComposerCapabilityItem & {
  catalogRevision: number
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function isSubsequence(query: string, candidate: string): boolean {
  let queryIndex = 0
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return false
}

function matchRank(item: ComposerCatalogItem, query: string): number | null {
  if (!query) return 5
  const name = normalized(item.name)
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (isSubsequence(query, name)) return 3
  if (normalized(item.description ?? '').includes(query)) return 4
  return null
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isComposerCapability(item: ComposerCatalogItem): item is ComposerCapabilityItem {
  return item.kind === 'skill' || item.kind === 'plugin_action' || item.kind === 'provider_app'
}

export function rankComposerCapabilities(
  catalog: ComposerCatalogSnapshot | null | undefined,
  query: string,
): RankedComposerCapability[] {
  if (!catalog) return []
  const normalizedQuery = normalized(query.trim())
  return catalog.items
    .filter(isComposerCapability)
    .filter((item) => item.enabled || item.disabled_reason === 'ambiguous_source_identity')
    .map((item) => ({ item, rank: matchRank(item, normalizedQuery) }))
    .filter((match): match is { item: ComposerCapabilityItem; rank: number } => match.rank !== null)
    .sort((left, right) => (
      left.rank - right.rank
      || SCOPE_ORDER[left.item.scope] - SCOPE_ORDER[right.item.scope]
      || compareText(normalized(left.item.source_label), normalized(right.item.source_label))
      || KIND_ORDER[left.item.kind] - KIND_ORDER[right.item.kind]
      || compareText(normalized(left.item.name), normalized(right.item.name))
      || compareText(left.item.id, right.item.id)
    ))
    .map(({ item }) => ({ ...item, catalogRevision: catalog.revision }))
}
