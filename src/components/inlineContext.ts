export type InlineContextKind = 'file' | 'directory'

export type InlineContextSuggestion = {
  kind: InlineContextKind
  name: string
  path: string
}

export type InlineContextReference = InlineContextSuggestion & {
  availability: 'available' | 'stale'
  id: string
}
