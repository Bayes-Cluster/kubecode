export type InlineContextKind = 'file' | 'directory'
export type InlineReferenceKind = InlineContextKind | 'capability'

export type InlineContextSuggestion = {
  kind: InlineContextKind
  name: string
  path: string
}

export type InlineCapabilitySuggestion = {
  catalogRevision: number
  description: string | null
  disabledReason: string | null
  enabled: boolean
  id: string
  itemKind: 'skill' | 'plugin_action' | 'provider_app'
  name: string
  scope: 'session' | 'project' | 'user' | 'bundled' | 'plugin'
  sourceLabel: string
}

export type InlineFileContextReference = Omit<InlineContextSuggestion, 'kind'> & {
  availability: 'available' | 'stale' | 'unsupported'
  id: string
  kind: InlineContextKind
}

export type InlineCapabilityReference = {
  availability: 'available' | 'stale' | 'unsupported'
  id: string
  itemKind: 'skill' | 'plugin_action' | 'provider_app'
  kind: 'capability'
  name: string
  path: string
  scope?: 'session' | 'project' | 'user' | 'bundled' | 'plugin'
  scopeLabel?: string
  sourceLabel?: string
}

export type InlineContextReference = InlineFileContextReference | InlineCapabilityReference
