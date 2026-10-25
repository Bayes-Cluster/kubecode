import { useEffect, useRef } from 'react'

import type { BundledLanguage } from 'shiki'

import { CodeBlock } from '@/components/ai-elements/code-block'
import { MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { NO_IMAGE_STREAMDOWN_PROPS } from '@/components/ai-elements/streamdown-hardening'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { KubecodeApi, ProjectContextDocument, ProjectContextItem, ProjectContextRef, WorkspaceEvent } from '../api'
import { prepareInlineMath } from '../markdown/inlineMath'
import { PROSE_ROOT } from '../markdown/MarkdownParts'
import { objectKindOf } from '../references/referenceLabels'
import { ReaderEmpty, ReaderLoading, ReaderNotice } from './ReaderStates'
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
  /**
   * The host's header already names the record (an inspector panel): only
   * what differs from what was cited is said here, not the title and kind again.
   */
  titledByHost?: boolean
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
  titledByHost = false,
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
    return <ReaderLoading>{t('kubecode.work.evidence.loading')}</ReaderLoading>
  }
  const recover = recovery && (
    <Button size="xs" variant="outline" onClick={recovery.run}>{recovery.label}</Button>
  )
  if (state.status === 'removed') {
    return <ReaderNotice action={recover} failed>{t('kubecode.work.evidence.removed')}</ReaderNotice>
  }
  if (state.status === 'error') {
    return (
      <ReaderNotice
        action={(
          <>
            <Button size="xs" variant="outline" onClick={state.retry}>{t('kubecode.vocab.command.retry')}</Button>
            {recover}
          </>
        )}
        failed
      >
        {t('kubecode.work.evidence.failed')}
      </ReaderNotice>
    )
  }
  const { doc } = state
  const version = formatVersion(target.kind, shownRevision, t)
  // Only something that was cited can have changed since it was cited.
  const changed = cited !== null && shownRevision !== null && cited !== shownRevision
  const citedVersion = cited ? formatVersion(target.kind, cited, t) : undefined
  const showCurrent = onShowCurrent ?? state.reload
  const format = recordFormat(target.kind, target.id)
  const showNewer = <Button size="xs" variant="outline" onClick={showCurrent}>{t('kubecode.resources.preview.showNewer')}</Button>
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-shown-revision={shownRevision ?? undefined}
      data-testid="evidence-viewer"
    >
      {titledByHost ? (changed || citedVersion) && (
        <div className="flex flex-wrap items-center gap-1">
          {changed && <Badge variant="warning">{t('kubecode.work.evidence.changed')}</Badge>}
          {citedVersion && <span className="text-xs text-muted-foreground">{t('kubecode.work.evidence.pinned', { revision: citedVersion })}</span>}
        </div>
      ) : (
      <Item size="compact">
        <ItemMedia variant="icon">
          <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[objectKindOf(target.kind)].Icon} />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="[overflow-wrap:anywhere]">{doc.title}</ItemTitle>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="secondary">{t(kindLabelKey(target.kind))}</Badge>
            {version && <Badge variant="outline">{version}</Badge>}
            {changed && <Badge variant="warning">{t('kubecode.work.evidence.changed')}</Badge>}
          </div>
          {citedVersion && <ItemDescription>{t('kubecode.work.evidence.pinned', { revision: citedVersion })}</ItemDescription>}
        </ItemContent>
      </Item>
      )}
      {state.newer && <ReaderNotice action={showNewer}>{t('kubecode.resources.preview.newer')}</ReaderNotice>}
      {unreadable && <ReaderNotice failed>{t('kubecode.work.evidence.failed')}</ReaderNotice>}
      {!unreadable && doc.sections.length === 0 && doc.notes.length === 0 && (
        <ReaderEmpty>{t('kubecode.work.evidence.empty')}</ReaderEmpty>
      )}
      {doc.sections.map((section, index) => (
        <section className="flex min-w-0 flex-col gap-1" key={`${section.heading}-${index}`}>
          {(index === 0 || section.heading !== doc.sections[index - 1].heading) && (
            <h5 className="text-sm font-medium">{target.kind === 'file' ? t('kubecode.work.evidence.fileNote') : section.heading}</h5>
          )}
          {/* A truncated section can end inside a fence, so it shows as text. */}
          {format.markdown && !section.truncated ? (
            // A Markdown record reads as a message body: the one MessageResponse (#278), with no image ever fetched.
            <MessageContent className="[overflow-wrap:anywhere]">
              <MessageResponse {...NO_IMAGE_STREAMDOWN_PROPS} {...PROSE_ROOT} mode="static">{prepareInlineMath(section.text)}</MessageResponse>
            </MessageContent>
          ) : (
            // The block scrolls as one region so a long file reads from the keyboard.
            <CodeBlock
              className={cn('overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring', compact ? 'max-h-[40vh]' : 'max-h-60')}
              data-testid="record-code"
              code={section.text}
              language={format.markdown ? ('text' as BundledLanguage) : format.language}
              tabIndex={0}
            />
          )}
          {section.truncated && <p className="text-xs text-muted-foreground">{t('kubecode.work.evidence.truncated')}</p>}
        </section>
      ))}
      {doc.notes.map((note) => (
        <p className="text-xs text-muted-foreground" key={note}>{note}</p>
      ))}
      {state.changedWhileReading && (
        <ReaderNotice action={showNewer}>{t('kubecode.resources.preview.changedWhileReading')}</ReaderNotice>
      )}
      {state.moreFailed && (
        <ReaderNotice
          action={<Button size="xs" variant="outline" onClick={state.loadMore}>{t('kubecode.retry')}</Button>}
          failed
        >
          {t('kubecode.work.evidence.moreFailed')}
        </ReaderNotice>
      )}
      {doc.next_cursor && !state.moreFailed && (
        <Button className="self-start" disabled={state.loadingMore} size="xs" variant="outline" onClick={state.loadMore}>
          {state.loadingMore && <Spinner aria-hidden="true" data-icon="inline-start" />}
          {t('kubecode.work.evidence.more')}
        </Button>
      )}
      {doc.related.length > 0 && (
        <section className="flex flex-col gap-1">
          <h5 className="text-sm font-medium">{t('kubecode.work.evidence.related')}</h5>
          <ItemGroup className="gap-1">
            {doc.related.map((item) => {
              const follows = onFollow !== undefined && (canFollow?.(item) ?? true)
              const media = (
                <ItemMedia variant="icon">
                  <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[objectKindOf(item.ref.kind)].Icon} />
                </ItemMedia>
              )
              return (
                <div key={`${item.ref.kind}:${item.ref.id}`} role="listitem">
                  {follows ? (
                    <Item asChild size="sm" variant="outline">
                      <button data-focus-key={`related:${item.ref.kind}:${item.ref.id}`} type="button" onClick={() => onFollow(item)}>
                        {media}
                        <ItemContent><ItemTitle>{item.title}</ItemTitle></ItemContent>
                      </button>
                    </Item>
                  ) : (
                    <Item size="sm">
                      {media}
                      <ItemContent><ItemTitle>{item.title}</ItemTitle></ItemContent>
                    </Item>
                  )}
                </div>
              )
            })}
          </ItemGroup>
        </section>
      )}
    </div>
  )
}
