import { useState } from 'react'

import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextKind, ProjectContextRef, WorkspaceEvent } from '../api'
import { RecordPreview, type DisplayedRecord } from '../resources/RecordPreview'

/** A record a task cites or owns, as the reader needs to open it. */
export type EvidenceTarget = {
  kind: string
  id: string
  /** The revision the task cited it at, if it was pinned. */
  revision?: string | null
}

/** A record as it was actually shown: the revision is the one read, not the one cited. */
export type DisplayedEvidence = DisplayedRecord

export type EvidenceViewerProps = {
  api: KubecodeApi
  projectId: string
  t: Translator
  target: EvidenceTarget
  events?: readonly WorkspaceEvent[]
  /**
   * Called after a record rendered successfully, with the revision on screen.
   * Never called while loading, for a read that failed, for a record that is
   * gone, or for a related record the reader moved on to.
   */
  onDisplayed?: (shown: DisplayedEvidence) => void
  /** Called once the cited record could not be read (failed, gone, or of a kind it cannot show). */
  onFailed?: () => void
  /**
   * Opens a related record elsewhere (the inspector pushes it), so what was
   * cited stays shown here. Without it, the related record replaces it.
   */
  onFollow?: (ref: { kind: string; id: string }) => void
}

/**
 * One cited record where the researcher is reviewing (ADR 0230 §4), through
 * the one record reader (ADR 0231 §4): read live, so what is accepted is what
 * is current and on screen, and compared with the revision the Task cited. A
 * Project file is read through the same context reader, a page at a time,
 * with the fingerprint evidence is pinned with.
 */
export function EvidenceViewer({ api, events, onDisplayed, onFailed, onFollow, projectId, t, target }: EvidenceViewerProps) {
  // Following a related record replaces what is shown; it is never reported as the cited one.
  const [followed, setFollowed] = useState<Pick<ProjectContextRef, 'kind' | 'id'> | null>(null)
  if (followed) {
    return (
      <RecordPreview
        api={api}
        events={events}
        key={`${followed.kind}:${followed.id}`}
        projectId={projectId}
        t={t}
        target={followed}
        onFollow={(item) => setFollowed({ kind: item.ref.kind, id: item.ref.id })}
      />
    )
  }
  return (
    <RecordPreview
      api={api}
      cited={target.revision ?? null}
      events={events}
      projectId={projectId}
      t={t}
      target={{ kind: target.kind as ProjectContextKind, id: target.id }}
      onDisplayed={onDisplayed}
      onFailed={onFailed}
      onFollow={(item) => {
        const ref = { kind: item.ref.kind, id: item.ref.id }
        if (onFollow) onFollow(ref)
        else setFollowed(ref)
      }}
    />
  )
}
