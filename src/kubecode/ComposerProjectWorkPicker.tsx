import { CircleAlert, Eye, FlaskConical, Loader2 } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type {
  KubecodeApi, ProjectContextDocument, ProjectContextItem, ProjectContextRef,
} from './api'
import {
  PROJECT_CONTEXT_KIND_LABELS,
  PROJECT_WORK_FILTERS,
  isOwnSessionReference,
  type ProjectWorkFilter,
} from './projectContext'

const SEARCH_DEBOUNCE_MS = 200
const PAGE_SIZE = 20

type ListState = {
  items: ProjectContextItem[]
  nextCursor: string | null
  status: 'error' | 'loading' | 'ready'
}

type PreviewState =
  | { status: 'closed' }
  | { status: 'error'; target: ProjectContextItem }
  | { status: 'loading'; target: ProjectContextItem }
  | { document: ProjectContextDocument; status: 'ready'; target: ProjectContextItem }

type ComposerProjectWorkPickerProps = {
  api: KubecodeApi
  conversationId: string
  onSelect: (item: ProjectContextItem) => void
  projectId: string
  t: Translator
}

/**
 * Discovers existing Project work and previews it read-only. Choosing a row
 * only hands its typed reference to the Composer; neither choosing nor
 * previewing starts an Agent or any other work.
 */
export function ComposerProjectWorkPicker({
  api,
  conversationId,
  onSelect,
  projectId,
  t,
}: ComposerProjectWorkPickerProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectWorkFilter>('all')
  const [list, setList] = useState<ListState>({ items: [], nextCursor: null, status: 'loading' })
  const [activeIndex, setActiveIndex] = useState(0)
  const [preview, setPreview] = useState<PreviewState>({ status: 'closed' })
  const requestRef = useRef(0)
  const previewRequestRef = useRef(0)
  const listboxId = useId()
  const kinds = useMemo(
    () => PROJECT_WORK_FILTERS.find((entry) => entry.id === filter)?.kinds ?? undefined,
    [filter],
  )

  useEffect(() => {
    const request = ++requestRef.current
    const timer = window.setTimeout(() => {
      setList((current) => ({ ...current, status: 'loading' }))
      api.searchProjectContext(projectId, { query: query.trim(), kinds, limit: PAGE_SIZE })
        .then((page) => {
          if (request !== requestRef.current) return
          setList({ items: page.items, nextCursor: page.next_cursor, status: 'ready' })
          setActiveIndex(0)
        })
        .catch(() => {
          if (request === requestRef.current) setList({ items: [], nextCursor: null, status: 'error' })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [api, kinds, projectId, query])

  const rows = useMemo(
    () => list.items.filter((item) => !isOwnSessionReference(item.ref, conversationId)),
    [conversationId, list.items],
  )
  const selectable = (item: ProjectContextItem | undefined) => (
    Boolean(item) && item?.availability === 'available'
  )
  const enabledIndexes = rows.flatMap((item, index) => (selectable(item) ? [index] : []))
  const current = selectable(rows[activeIndex]) ? activeIndex : enabledIndexes[0] ?? -1

  const loadMore = () => {
    if (!list.nextCursor) return
    const request = ++requestRef.current
    api.searchProjectContext(projectId, {
      query: query.trim(), kinds, limit: PAGE_SIZE, cursor: list.nextCursor,
    }).then((page) => {
      if (request !== requestRef.current) return
      setList((previous) => ({
        items: [...previous.items, ...page.items],
        nextCursor: page.next_cursor,
        status: 'ready',
      }))
    }).catch(() => {
      if (request === requestRef.current) setList((previous) => ({ ...previous, status: 'error' }))
    })
  }

  const openPreview = (target: ProjectContextItem) => {
    const request = ++previewRequestRef.current
    setPreview({ status: 'loading', target })
    api.readProjectContext(projectId, target.ref, 'content').then((document) => {
      if (request === previewRequestRef.current) setPreview({ document, status: 'ready', target })
    }).catch(() => {
      if (request === previewRequestRef.current) setPreview({ status: 'error', target })
    })
  }

  const move = (direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return
    const position = Math.max(0, enabledIndexes.indexOf(current))
    setActiveIndex(enabledIndexes[(position + direction + enabledIndexes.length) % enabledIndexes.length])
  }

  const kindLabel = (ref: ProjectContextRef) => t(PROJECT_CONTEXT_KIND_LABELS[ref.kind])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-2">
        <Input
          aria-activedescendant={current >= 0 ? `${listboxId}-option-${current}` : undefined}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded
          aria-label={t('kubecode.searchProjectWork')}
          autoFocus
          className="h-9 border-0 bg-transparent shadow-none focus-visible:ring-0"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // IME composition must never select or move.
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'ArrowRight' && rows[current] && query === '') {
              event.preventDefault()
              openPreview(rows[current])
            } else if ((event.key === 'Enter' || event.key === 'Tab') && rows[current]) {
              event.preventDefault()
              onSelect(rows[current])
            }
          }}
          placeholder={t('kubecode.searchProjectWork')}
          role="combobox"
          value={query}
        />
        <div aria-label={t('kubecode.projectWorkFilters')} className="mt-1 flex flex-wrap gap-1" role="group">
          {PROJECT_WORK_FILTERS.map((entry) => (
            <Button
              aria-pressed={filter === entry.id}
              className="h-7 rounded-full px-2.5 text-xs"
              key={entry.id}
              onClick={() => setFilter(entry.id)}
              size="sm"
              type="button"
              variant={filter === entry.id ? 'secondary' : 'ghost'}
            >
              {t(entry.label)}
            </Button>
          ))}
        </div>
      </div>
      <p className="px-3 pt-2 text-xs text-muted-foreground">{t('kubecode.projectWorkReadOnly')}</p>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="project-work-results">
        {list.status === 'loading' && rows.length === 0 ? (
          <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden className="animate-spin" size={14} />
            {t('kubecode.loadingContext')}
          </p>
        ) : list.status === 'error' ? (
          <p className="px-3 py-3 text-sm text-destructive" role="alert">
            {t('kubecode.contextLoadFailed')}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground" role="status">
            {t('kubecode.projectWorkEmpty')}
          </p>
        ) : (
          <ul aria-label={t('kubecode.projectWorkResults')} id={listboxId} role="listbox">
            {rows.map((item, index) => {
              const enabled = selectable(item)
              return (
                <li
                  aria-disabled={!enabled}
                  aria-selected={index === current}
                  className={cn(
                    'flex items-stretch gap-1 rounded-xl',
                    index === current && 'bg-accent text-accent-foreground',
                  )}
                  id={`${listboxId}-option-${index}`}
                  key={`${item.ref.kind}:${item.ref.id}`}
                  onMouseEnter={() => enabled && setActiveIndex(index)}
                  role="option"
                >
                  <button
                    className="flex min-w-0 flex-1 items-start gap-3 rounded-xl px-3 py-2 text-left disabled:opacity-60"
                    disabled={!enabled}
                    onClick={() => onSelect(item)}
                    tabIndex={-1}
                    type="button"
                  >
                    <FlaskConical aria-hidden className="mt-0.5 shrink-0" size={18} />
                    <span className="min-w-0">
                      <strong className="block truncate font-medium">{item.title}</strong>
                      <small className="block truncate text-xs text-muted-foreground">
                        {[
                          kindLabel(item.ref),
                          item.provenance.state,
                          item.provenance.author,
                          item.provenance.updated_at,
                        ].filter(Boolean).join(' · ')}
                      </small>
                      {item.summary && (
                        <small className="line-clamp-2 block whitespace-normal text-sm font-normal text-muted-foreground">
                          {item.summary}
                        </small>
                      )}
                      {!enabled && (
                        <small className="flex items-center gap-1 text-xs text-destructive">
                          <CircleAlert aria-hidden size={12} />
                          {t('kubecode.projectWorkUnavailable')}
                        </small>
                      )}
                    </span>
                  </button>
                  <Button
                    aria-label={t('kubecode.projectWorkPreviewItem', { title: item.title })}
                    className="my-auto h-8 w-8 shrink-0"
                    onClick={() => openPreview(item)}
                    size="icon-sm"
                    tabIndex={-1}
                    type="button"
                    variant="ghost"
                  >
                    <Eye size={16} />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {list.nextCursor && list.status === 'ready' && (
          <Button className="mt-1 w-full" onClick={loadMore} size="sm" type="button" variant="ghost">
            {t('kubecode.projectWorkLoadMore')}
          </Button>
        )}
      </div>
      {preview.status !== 'closed' && (
        <section
          aria-label={t('kubecode.projectWorkPreview')}
          className="max-h-56 overflow-y-auto border-t border-border p-3 text-sm"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <strong className="min-w-0 truncate">{preview.target.title}</strong>
            <Button
              onClick={() => setPreview({ status: 'closed' })}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t('kubecode.projectWorkClosePreview')}
            </Button>
          </div>
          {preview.status === 'loading' ? (
            <p className="text-muted-foreground" role="status">{t('kubecode.loadingContext')}</p>
          ) : preview.status === 'error' ? (
            <p className="text-destructive" role="alert">{t('kubecode.projectWorkPreviewFailed')}</p>
          ) : (
            <>
              {preview.document.sections.map((section) => (
                <div className="mb-2" key={section.heading}>
                  <h4 className="text-xs font-medium text-muted-foreground">{section.heading}</h4>
                  <p className="whitespace-pre-wrap break-words">{section.text}</p>
                </div>
              ))}
              {preview.document.notes.map((note) => (
                <p className="text-xs text-muted-foreground" key={note}>{note}</p>
              ))}
              {preview.document.related.filter((related) => (
                !isOwnSessionReference(related.ref, conversationId)
                && related.availability === 'available'
                && related.ref.kind === 'session_turn'
              )).map((related) => (
                <Button
                  className="h-auto w-full justify-start px-2 py-1.5 text-left"
                  key={`${related.ref.kind}:${related.ref.id}`}
                  onClick={() => onSelect(related)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <span className="min-w-0 truncate">
                    {t('kubecode.projectWorkReferenceItem', { title: related.title })}
                  </span>
                </Button>
              ))}
            </>
          )}
        </section>
      )}
    </div>
  )
}
