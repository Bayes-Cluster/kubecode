import { useEffect, useRef, useState } from 'react'

import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import {
  ApiError,
  type KubecodeApi,
  type ProjectContextDocument,
  type ProjectContextKind,
  type ProjectContextSection,
} from '../api'

/** A record a task cites or owns, as the reader needs to open it. */
export type EvidenceTarget = {
  kind: string
  id: string
  /** The revision the task cited it at, if it was pinned. */
  revision?: string | null
}

/** Marks the one section of a file, worded at render time. */
const FILE_NOTE = '\u0000file'

const CONTEXT_KINDS = new Set<string>([
  'research', 'round', 'import', 'finding', 'session', 'session_turn', 'team', 'team_task',
  'experiment', 'artifact', 'work', 'thread', 'channel',
])

type Loaded = {
  title: string
  availability: 'available' | 'changed' | 'removed'
  sections: ProjectContextSection[]
  related: ProjectContextDocument['related']
  notes: string[]
  cursor: string | null
  revision: string | null
}

type State = { status: 'loading' } | { status: 'error'; removed: boolean } | { status: 'ready'; data: Loaded }

/** A record as it was actually shown: the revision is the one read, not the one cited. */
export type DisplayedEvidence = { kind: string; id: string; revision: string | null; title: string }

export type EvidenceViewerProps = {
  api: KubecodeApi
  projectId: string
  t: Translator
  target: EvidenceTarget
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
 * Opens one cited record where the researcher is reviewing: an experiment with
 * its output tail and artifacts, an artifact, a finding or discussion, or a
 * Project file. Content is read from the same sources as everywhere else
 * (ProjectContext and the file reader), never copied, and a record the task
 * cited that has changed or vanished says so.
 */
export function EvidenceViewer({ api, onDisplayed, onFailed, onFollow, projectId, t, target }: EvidenceViewerProps) {
  // Following a related record replaces what is shown; a different target
  // (the host remounts this by key) starts over.
  const [followed, setFollowed] = useState<EvidenceTarget | null>(null)
  const current = followed ?? target
  const original = followed === null
  const requestKey = `${projectId}|${current.kind}|${current.id}|${current.revision ?? ''}`
  const [loaded, setLoaded] = useState<{ key: string; result: State } | null>(null)
  const state: State = loaded && loaded.key === requestKey ? loaded.result : { status: 'loading' }
  const targetRevision = target.revision
  // A failed "Load more" keeps what is shown; it is said next to it.
  const [moreError, setMoreError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const load = async (): Promise<Loaded> => {
      if (current.kind === 'file') {
        const file = await api.readFile(projectId, current.id)
        return {
          title: current.id,
          availability: current.revision && current.revision !== file.revision ? 'changed' : 'available',
          sections: [{ heading: FILE_NOTE, text: file.content, truncated: false }],
          related: [],
          notes: [],
          cursor: null,
          revision: file.revision,
        }
      }
      if (!CONTEXT_KINDS.has(current.kind)) throw new ApiError('not_found', 'unsupported', 404)
      const document = await api.readProjectContext(
        projectId,
        { kind: current.kind as ProjectContextKind, id: current.id },
        'content',
      )
      return {
        title: document.title,
        availability: document.availability,
        sections: document.sections,
        related: document.related,
        notes: document.notes,
        cursor: document.next_cursor,
        revision: document.ref.revision ?? null,
      }
    }
    load().then(
      (data) => { if (live) setLoaded({ key: requestKey, result: { status: 'ready', data } }) },
      (cause) => {
        if (live) {
          setLoaded({
            key: requestKey,
            result: { status: 'error', removed: cause instanceof ApiError && cause.status === 404 },
          })
        }
      },
    )
    return () => { live = false }
  }, [api, current, projectId, requestKey])

  // Reported after commit, when the cited record's content is on screen; a
  // failed read, a record the server reports as removed, or a related record
  // followed in place never is.
  const shown = original && state.status === 'ready' && state.data.availability !== 'removed'
  const shownKind = shown ? current.kind : null
  const shownId = shown ? current.id : null
  const shownRevision = shown ? state.data.revision : null
  const shownTitle = shown ? state.data.title : null
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (shownKind === null || shownId === null || shownTitle === null) return
    const key = `${requestKey}@${shownRevision ?? ''}`
    if (reported.current === key) return
    reported.current = key
    onDisplayed?.({ kind: shownKind, id: shownId, revision: shownRevision, title: shownTitle })
  }, [onDisplayed, requestKey, shownId, shownKind, shownRevision, shownTitle])

  const failed = original && state.status === 'error'
  useEffect(() => {
    if (failed) onFailed?.()
  }, [failed, onFailed])

  const more = async () => {
    if (state.status !== 'ready' || !state.data.cursor || !CONTEXT_KINDS.has(current.kind)) return
    setMoreError(null)
    try {
      const page = await api.readProjectContext(
        projectId,
        { kind: current.kind as ProjectContextKind, id: current.id },
        'content',
        state.data.cursor,
      )
      setLoaded((previous) => (previous && previous.key === requestKey && previous.result.status === 'ready'
        ? {
          key: requestKey,
          result: {
            status: 'ready',
            data: {
              ...previous.result.data,
              sections: [...previous.result.data.sections, ...page.sections],
              cursor: page.next_cursor,
            },
          },
        }
        : previous))
    } catch {
      setMoreError(t('kubecode.work.evidence.moreFailed'))
    }
  }

  if (state.status === 'loading') {
    return <p className="kubecode-research-muted" role="status">{t('kubecode.work.evidence.loading')}</p>
  }
  if (state.status === 'error') {
    return (
      <p className="kubecode-research-error" role="alert">
        {state.removed ? t('kubecode.work.evidence.removed') : t('kubecode.work.evidence.failed')}
      </p>
    )
  }
  const { data } = state
  const changed = data.availability === 'changed'
    || (original && targetRevision != null && data.revision != null && targetRevision !== data.revision)
  return (
    <div
      className="kubecode-work-evidence"
      data-shown-revision={original ? data.revision ?? undefined : undefined}
      data-testid="evidence-viewer"
    >
      <strong>{data.title}</strong>
      {changed && (
        <StatusBadge tone="warn">{t('kubecode.work.evidence.changed')}</StatusBadge>
      )}
      {data.availability === 'removed' && (
        <StatusBadge tone="warn">{t('kubecode.work.evidence.removed')}</StatusBadge>
      )}
      {original && targetRevision && (
        <small className="kubecode-research-muted">
          {t('kubecode.work.evidence.pinned', { revision: targetRevision.slice(0, 12) })}
        </small>
      )}
      {data.sections.length === 0 && (
        <p className="kubecode-research-muted">{t('kubecode.work.evidence.empty')}</p>
      )}
      {data.sections.map((section, index) => (
        <section key={`${section.heading}-${index}`}>
          <h5>{section.heading === FILE_NOTE ? t('kubecode.work.evidence.fileNote') : section.heading}</h5>
          <pre className="kubecode-work-evidence-text" tabIndex={0}>{section.text}</pre>
          {section.truncated && (
            <small className="kubecode-research-muted">{t('kubecode.work.evidence.truncated')}</small>
          )}
        </section>
      ))}
      {data.notes.map((note) => (
        <small className="kubecode-research-muted" key={note}>{note}</small>
      ))}
      {moreError && (
        <p className="kubecode-research-error" role="alert">
          {moreError}{' '}
          <Button size="xs" variant="ghost" onClick={() => void more()}>{t('kubecode.retry')}</Button>
        </p>
      )}
      {data.cursor && (
        <Button size="xs" variant="outline" onClick={() => void more()}>
          {t('kubecode.work.evidence.more')}
        </Button>
      )}
      {data.related.length > 0 && (
        <section>
          <h5>{t('kubecode.work.evidence.related')}</h5>
          <ul>
            {data.related.map((item) => (
              <li key={`${item.ref.kind}:${item.ref.id}`}>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    const ref = { kind: item.ref.kind, id: item.ref.id }
                    if (onFollow) onFollow(ref)
                    else {
                      setMoreError(null)
                      setFollowed(ref)
                    }
                  }}
                >
                  {item.title}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
