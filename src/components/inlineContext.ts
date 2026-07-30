export type InlineContextKind = 'file' | 'directory' | 'git_diff' | 'terminal'
export type InlineReferenceKind = InlineContextKind | 'capability'

export type InlineContextSuggestion = {
  kind: InlineContextKind
  name: string
  path: string
  enabled?: boolean
  disabledReason?: string | null
  description?: string
  selector?: string
  sourceRevision?: string
  summary?: {
    kind: 'git_diff'
    scope: 'all' | 'file'
    file_count: number
    hunk_count: number
    byte_count: number
  } | {
    kind: 'terminal'
    capture: 'selection' | 'recent'
    pane_index: number
    line_count: number
    byte_count: number
    truncated: boolean
  }
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
  enabled?: never
  disabledReason?: never
  description?: never
  selector?: never
  sourceRevision?: never
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
