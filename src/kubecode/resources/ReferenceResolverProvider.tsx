import { useEffect, useMemo, type ReactNode } from 'react'

import type { KubecodeApi, WorkspaceEvent } from '../api'
import { createReferenceStatusStore, ReferenceStatusContext } from './referenceStatus'

/**
 * Resolves every reference shown in the active Workspace in batches (ADR
 * 0231 §5). A new Workspace starts a new store, so an answer for another
 * Workspace is never shown here.
 */
export function ReferenceResolverProvider({ api, children, events, projectId }: {
  api: KubecodeApi
  projectId: string | null
  events: readonly WorkspaceEvent[]
  children: ReactNode
}) {
  const store = useMemo(() => (projectId ? createReferenceStatusStore(api, projectId) : null), [api, projectId])
  useEffect(() => { store?.observe(events) }, [events, store])
  return <ReferenceStatusContext.Provider value={store}>{children}</ReferenceStatusContext.Provider>
}
