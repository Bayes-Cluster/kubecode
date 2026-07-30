export type InlineContextKind = 'file' | 'directory'
export type InlineReferenceKind = InlineContextKind | 'capability'

export type InlineContextSuggestion = {
  kind: InlineContextKind
  name: string
  path: string
}

export type InlineContextReference = Omit<InlineContextSuggestion, 'kind'> & {
  availability: 'available' | 'stale' | 'unsupported'
  id: string
  kind: InlineReferenceKind
}
