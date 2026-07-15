export interface WorkspaceIdentity {
  id: string
  label: string
  alias: string
  path: string
  shortLabel: string
  color: string | null
  icon: string | null
  mounted: boolean
  available: boolean
  defaultForNewNotes: boolean
}

export interface VaultEntry {
  path: string
  filename: string
  title: string
  isA: string | null
  aliases: string[]
  archived: boolean
  icon: string | null
  color: string | null
  workspace?: WorkspaceIdentity
}
