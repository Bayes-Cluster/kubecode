/**
 * What a panel inside the inspector may use (ADR 0228 §3): its own entry and
 * the stack commands (`useInspectorEntry`), the stack's record of which
 * versions were actually displayed (`useInspectionRecord`), and the shell's
 * shared dependencies (`useInspectorServices`). Panels never read the route
 * and never draw their own aside, Back, or Close.
 */

import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'

import type { ViewHeaderProps } from '@/components/workspace/ViewHeader'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  Conversation,
  KubecodeApi,
  Member,
  TaskBoard,
  TaskDraft,
  TeamSnapshot,
  WorkspaceEvent,
} from '../../api'
import type { WorkspaceConnectionState } from '../../useWorkspaceEventStream'
import type { InspectorEntry } from '../location/inspector'
import type { InspectorPresentation } from './useInspectorPresentation'

/** The Back and Close of one entry's ViewHeader, computed by the pane per presentation and depth. */
export type InspectorHeader = Pick<ViewHeaderProps, 'back' | 'close'> & { level: 3 }

export type InspectorEntryApi = {
  entry: InspectorEntry
  /** 1 is the entry opened from the view. */
  depth: number
  /** Whether this entry is the top of the stack (the others are covered and inert). */
  active: boolean
  presentation: InspectorPresentation
  header: InspectorHeader
  /** Opens something from inside this entry; `from` is the `data-focus-key` to return to. */
  push(entry: InspectorEntry, options?: { from?: string }): void
  /** Swaps the top: the next piece of evidence, a newer version. */
  replace(entry: InspectorEntry): void
  back(): void
  close(): void
  /** This entry's loaded title, for the next level's "Back to …". */
  setTitle(text: string): void
}

export const InspectorEntryContext = createContext<InspectorEntryApi | null>(null)

/** The entry a panel renders, and the stack commands. Only inside an InspectorPane. */
export function useInspectorEntry(): InspectorEntryApi {
  const value = useContext(InspectorEntryContext)
  if (!value) throw new Error('useInspectorEntry is used outside an inspector entry')
  return value
}

/** A record by kind and id; its version is what was displayed. */
export type InspectedRecord = { kind: string; id: string }

export type InspectionRecord = {
  /** Call ONLY after that revision rendered successfully; a failed read never counts. */
  markDisplayed(ref: InspectedRecord, revision: string | null): void
  /** `undefined`: never displayed in this stack; `null`: displayed, with no revision. */
  displayedRevision(ref: InspectedRecord): string | null | undefined
}

export type InspectionRecordStore = {
  markDisplayed: InspectionRecord['markDisplayed']
  subscribe(listener: () => void): () => void
  /** Replaced, never changed, on every new record. */
  snapshot(): ReadonlyMap<string, string | null>
}

const recordKey = (ref: InspectedRecord) => `${ref.kind}:${ref.id}`

/** One per stack: it starts empty when the stack opens on a new root and is dropped on close. */
export function createInspectionRecordStore(): InspectionRecordStore {
  let shown: ReadonlyMap<string, string | null> = new Map()
  const listeners = new Set<() => void>()
  return {
    markDisplayed(ref, revision) {
      const key = recordKey(ref)
      if (shown.has(key) && shown.get(key) === revision) return
      shown = new Map(shown).set(key, revision)
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot: () => shown,
  }
}

export const InspectionRecordContext = createContext<InspectionRecordStore | null>(null)

/**
 * Which version of each record this stack actually displayed, so a review can
 * bind acceptance to a version the researcher saw (#218). Re-renders when the
 * record changes.
 */
export function useInspectionRecord(): InspectionRecord {
  const store = useContext(InspectionRecordContext)
  if (!store) throw new Error('useInspectionRecord is used outside an inspector')
  const shown = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  return useMemo(() => ({
    markDisplayed: store.markDisplayed,
    displayedRevision: (ref: InspectedRecord) => {
      const key = recordKey(ref)
      return shown.has(key) ? shown.get(key) : undefined
    },
  }), [shown, store])
}

/** The shell's shared dependencies, so panels need no long prop lists. */
export type InspectorServices = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  /** The app's language, for dates and times; English when absent. */
  locale?: string
  /** The live roster of the active Workspace; empty while it loads. */
  roster: Member[]
  sessionCatalog: Conversation[]
  t: Translator
  /** The Workspace's board, its proposals and its archived Tasks, as the board view has them. */
  taskBoard?: { board: TaskBoard | null; drafts: TaskDraft[]; reload(): void }
  teams: TeamSnapshot[]
  /** A Session a panel started (a Task's discussion), for the shell's lists. */
  onConversationCreated(conversation: Conversation): void
}

export const InspectorServicesContext = createContext<InspectorServices | null>(null)

export function useInspectorServices(): InspectorServices {
  const value = useContext(InspectorServicesContext)
  if (!value) throw new Error('useInspectorServices is used outside the Workspace shell')
  return value
}
