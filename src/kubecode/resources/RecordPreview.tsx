import { useEffect, useRef } from 'react'

import { Streamdown } from 'streamdown'
import type { BundledLanguage } from 'shiki'

import { CodeBlock } from '@/components/ai-elements/code-block'
import { NO_IMAGE_STREAMDOWN_PROPS } from '@/components/ai-elements/streamdown-hardening'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { KubecodeApi, ProjectContextDocument, ProjectContextItem, ProjectContextRef, WorkspaceEvent } from '../api'
import { objectKindOf } from '../references/referenceLabels'
import { formatVersion, kindLabelKey } from './referenceKinds'
import { useRecordDocument } from './useRecordDocument'

/** A record as it was actually shown: the revision is the one displayed, not the one asked for. */
export type DisplayedRecord = { kind: string; id: string; revision: string | null; title: string }

export type RecordPreviewProps = {
  api: KubecodeApi
  t: Translator
  projectId: string
  target: Pick<ProjectContextRef, 'kind' | 'id'>
  /** Relevant changes mark what is shown as out of date; nothing is replaced under the reader. */
  events?: readonly WorkspaceEvent[]
  /** The revision a Task or message cited, to say when what is shown differs from it. */
  cited?: string | null
  /**
   * Called after a commit that shows the record's content, once per shown
   * revision. Never while loading, for a failed read, for a record that is
   * gone, or for a file that has no text to show.
   */
  onDisplayed?: (shown: DisplayedRecord) => void
  /**
   * Called whenever none of the record is on screen: on mount while it
   * loads, while it is read again, and once a read failed or found it gone.
   * A host that offers the version on screen forgets it here.
   */
  onCleared?: () => void
  /** Called once the record could not be read: `removed` when it is gone or of a kind it cannot show. */
  onFailed?: (reason: 'failed' | 'removed') => void
  /** The first page as read, for what a host shows around it (provenance). */
  onLoaded?: (doc: ProjectContextDocument) => void
  /** Opens a related record; without it, related records are listed as text. */
  onFollow?: (item: ProjectContextItem) => void
  /** Which related records can be followed; the others are listed as text. */
  canFollow?: (item: ProjectContextItem) => boolean
  /** Shows the current version (the host replaces the entry); without it, the reader reads it again in place. */
  onShowCurrent?: () => void
  /** A narrower layout for a dialog or a picker. */
  compact?: boolean
  /** Somewhere to look for the material again, offered when it is gone or could not be read. */
  recovery?: { label: string; run: () => void }
}

/** File extensions whose text is highlighted, and the one Shiki language each loads (ADR 0244). */
const CODE_LANGUAGES: Record<string, BundledLanguage> = {
  c: 'c', cpp: 'cpp', css: 'css', go: 'go', h: 'c', html: 'html', ipynb: 'json', java: 'java',
  jl: 'julia', js: 'javascript', json: 'json', jsx: 'jsx', mjs: 'javascript', py: 'python', r: 'r',
  rs: 'rust', sh: 'shellscript', sql: 'sql', tex: 'latex', toml: 'toml', ts: 'typescript', tsx: 'tsx',
  yaml: 'yaml', yml: 'yaml',
}
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

/**
 * How a section's text is shown: a code or text file in the official Code
 * Block (plain `text` when the language is not known, so nothing is
 * guessed); a Markdown file as hardened streamdown with no images fetched.
 * Written records (briefs, findings, threads, logs) are not known to be
 * markdown, so they show verbatim as plain text, as they always have.
 */
function recordFormat(kind: string, id: string): { markdown: true } | { markdown: false; language: BundledLanguage } {
  if (kind !== 'file') return { markdown: false, language: 'text' as BundledLanguage }
  const name = id.split('/').pop() ?? id
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (MARKDOWN_EXTENSIONS.has(extension)) return { markdown: true }
  return { markdown: false, language: CODE_LANGUAGES[extension] ?? ('text' as BundledLanguage) }
}

/**
 * The one read-only view of a Workspace record (ADR 0231 §4): the inspector's
 * resource, evidence a Task cites, the Add context preview, and the Session
 * picker's preview all render this. It reads through the context reader a
 * page at a time and never changes content under the reader: a newer version
 * is announced and shown only on request.
 */
export function RecordPreview({
  api,
  canFollow,
  cited = null,
  compact = false,
  events = [],
  onCleared,
  onDisplayed,
  onFailed,
  onFollow,
  onLoaded,
  onShowCurrent,
  projectId,
  recovery,
  t,
  target,
}: RecordPreviewProps) {
  const state = useRecordDocument(api, projectId, target, events)
  const ready = state.status === 'ready' ? state : null
  // Content is on screen only when there is some: a file that is not text has a revision but nothing shown.
  const displayed = ready !== null && (target.kind !== 'file' || ready.doc.sections.length > 0)
  const shownRevision = ready?.shownRevision ?? null
  const shownTitle = displayed ? ready.doc.title : null
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (shownTitle === null) return
    const key = `${projectId}|${target.kind}|${target.id}@${shownRevision ?? ''}`
    if (reported.current === key) return
    reported.current = key
    onDisplayed?.({ kind: target.kind, id: target.id, revision: shownRevision, title: shownTitle })
  }, [onDisplayed, projectId, shownRevision, shownTitle, target.id, target.kind])
  const onScreen = shownTitle !== null
  useEffect(() => {
    if (onScreen) return
    // Whatever shows next is reported, even the same version again.
    reported.current = null
    onCleared?.()
  }, [onCleared, onScreen])

  // A file with no text to show (not UTF-8) was read, but nothing of it could be shown: that is a failed display.
  const unreadable = ready !== null && !displayed
  const failed = state.status === 'error' || unreadable ? 'failed' : state.status === 'removed' ? 'removed' : null
  useEffect(() => {
    if (failed) onFailed?.(failed)
  }, [failed, onFailed])
  const loadedDoc = ready?.doc ?? null
  const loadedOnce = useRef<ProjectContextDocument | null>(null)
  useEffect(() => {
    if (!loadedDoc || loadedOnce.current === loadedDoc) return
    loadedOnce.current = loadedDoc
    onLoaded?.(loadedDoc)
  }, [loadedDoc, onLoaded])

  if (state.status === 'loading') {
    return <p className="kubecode-research-muted" role="status">{t('kubecode.work.evidence.loading')}</p>
  }
  const recover = recovery && (
    <Button size="xs" variant="outline" onClick={recovery.run}>{recovery.label}</Button>
  )
  if (state.status === 'removed') {
    return (
      <p className="kubecode-research-error" role="alert">
        {t('kubecode.work.evidence.removed')}{recover && ' '}{recover}
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p className="kubecode-research-error" role="alert">
        {t('kubecode.work.evidence.failed')}{' '}
        <Button size="xs" variant="ghost" onClick={state.retry}>{t('kubecode.vocab.command.retry')}</Button>
        {recover && ' '}{recover}
      </p>
    )
  }
  const { doc } = state
  const version = formatVersion(target.kind, shownRevision, t)
  // Only something that was cited can have changed since it was cited.
  const changed = cited !== null && shownRevision !== null && cited !== shownRevision
  const citedVersion = cited ? formatVersion(target.kind, cited, t) : undefined
  const showCurrent = onShowCurrent ?? state.reload
  const format = recordFormat(target.kind, target.id)
  return (
    <div
      className={cn('kubecode-work-evidence kubecode-record-preview', compact && 'kubecode-record-preview-compact')}
      data-shown-revision={shownRevision ?? undefined}
     
      data-testid="evidence-viewer"
    >
      <div className="kubecode-record-preview-meta">
        <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[objectKindOf(target.kind)].Icon} />
        <strong>{doc.title}</strong>
        <StatusBadge tone="muted">{t(kindLabelKey(target.kind))}</StatusBadge>
        {version && <StatusBadge tone="muted">{version}</StatusBadge>}
        {changed && <StatusBadge tone="warn">{t('kubecode.work.evidence.changed')}</StatusBadge>}
        {citedVersion && (
          <small className="kubecode-research-muted">{t('kubecode.work.evidence.pinned', { revision: citedVersion })}</small>
        )}
      </div>
      {state.newer && (
        <p className="kubecode-research-notice" role="status">
          {t('kubecode.resources.preview.newer')}{' '}
          <Button size="xs" variant="outline" onClick={showCurrent}>{t('kubecode.resources.preview.showNewer')}</Button>
        </p>
      )}
      {unreadable && <p className="kubecode-research-error" role="alert">{t('kubecode.work.evidence.failed')}</p>}
      {!unreadable && doc.sections.length === 0 && doc.notes.length === 0 && (
        <p className="kubecode-research-muted">{t('kubecode.work.evidence.empty')}</p>
      )}
      {doc.sections.map((section, index) => (
        <section key={`${section.heading}-${index}`}>
          {(index === 0 || section.heading !== doc.sections[index - 1].heading) && (
            <h5>{target.kind === 'file' ? t('kubecode.work.evidence.fileNote') : section.heading}</h5>
          )}
          {/* A truncated section can end inside a fence, so it shows as text. */}
          {format.markdown && !section.truncated ? (
            <div className="kubecode-record-markdown">
              <Streamdown {...NO_IMAGE_STREAMDOWN_PROPS} mode="static">{section.text}</Streamdown>
            </div>
          ) : (
            // The block scrolls as one region so a long file reads from the keyboard.
            <CodeBlock
              className="kubecode-record-code"
              code={section.text}
              language={format.markdown ? ('text' as BundledLanguage) : format.language}
              tabIndex={0}
            />
          )}
          {section.truncated && (
            <small className="kubecode-research-muted">{t('kubecode.work.evidence.truncated')}</small>
          )}
        </section>
      ))}
      {doc.notes.map((note) => (
        <small className="kubecode-research-muted" key={note}>{note}</small>
      ))}
      {state.changedWhileReading && (
        <p className="kubecode-research-notice" role="status">
          {t('kubecode.resources.preview.changedWhileReading')}{' '}
          <Button size="xs" variant="outline" onClick={showCurrent}>{t('kubecode.resources.preview.showNewer')}</Button>
        </p>
      )}
      {state.moreFailed && (
        <p className="kubecode-research-error" role="alert">
          {t('kubecode.work.evidence.moreFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={state.loadMore}>{t('kubecode.retry')}</Button>
        </p>
      )}
      {doc.next_cursor && !state.moreFailed && (
        <Button disabled={state.loadingMore} size="xs" variant="outline" onClick={state.loadMore}>
          {t('kubecode.work.evidence.more')}
        </Button>
      )}
      {doc.related.length > 0 && (
        <section>
          <h5>{t('kubecode.work.evidence.related')}</h5>
          <ul className="kubecode-record-preview-related">
            {doc.related.map((item) => (
              <li key={`${item.ref.kind}:${item.ref.id}`}>
                {onFollow && (canFollow?.(item) ?? true) ? (
                  <Button size="xs" variant="ghost" onClick={() => onFollow(item)}>
                    <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[objectKindOf(item.ref.kind)].Icon} />
                    {item.title}
                  </Button>
                ) : (
                  <span>{item.title}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
