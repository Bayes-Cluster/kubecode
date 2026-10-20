import { CircleAlert, Eye, FlaskConical, Loader2 } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { KubecodeApi, ProjectContextItem, ProjectContextKind, ProjectContextRef } from './api'
import {
  PROJECT_CONTEXT_KIND_LABELS,
  PROJECT_WORK_FILTERS,
  isOwnSessionReference,
  type ProjectWorkFilter,
} from './projectContext'
import { RecordPreview } from './resources/RecordPreview'

const SEARCH_DEBOUNCE_MS = 200
const PAGE_SIZE = 20

type ListState = {
  items: ProjectContextItem[]
  loadMoreFailed: boolean
  nextCursor: string | null
  status: 'error' | 'loading' | 'ready'
  /** The kinds the server cut short, so the list says it is not everything. */
  truncatedKinds: ProjectContextKind[]
}

/** `scope` is the search the preview was opened from: a new search closes it. */
type PreviewState = { status: 'closed' } | { scope: string; status: 'open'; target: ProjectContextItem }

const CLOSED_PREVIEW: PreviewState = { status: 'closed' }

type ComposerProjectWorkPickerProps = {
  api: KubecodeApi
  conversationId: string
  onSelect: (item: ProjectContextItem) => void
  projectId: string
  t: Translator
  /** The app's language, to list kinds in words. */
  locale?: string
}

/**
 * The Session composer's discovery of existing Project work (ADR 0214 §6),
 * previewed through the one record reader (ADR 0231 §4). Choosing a row only
 * hands its typed reference to the Composer; neither choosing nor previewing
 * starts an Agent or any other work. Project files are never offered here: a
 * Session cites files under its own execution root.
 */
export function ComposerProjectWorkPicker({
  api,
  conversationId,
  locale,
  onSelect,
  projectId,
  t,
}: ComposerProjectWorkPickerProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectWorkFilter>('all')
  const [list, setList] = useState<ListState>({
    items: [], loadMoreFailed: false, nextCursor: null, status: 'loading', truncatedKinds: [],
  })
  const [activeIndex, setActiveIndex] = useState(0)
  const [preview, setPreview] = useState<PreviewState>(CLOSED_PREVIEW)
  const requestRef = useRef(0)
  const listboxId = useId()
  const kinds = useMemo(
    () => PROJECT_WORK_FILTERS.find((entry) => entry.id === filter)?.kinds ?? undefined,
    [filter],
  )
  const scope = `${filter}|${query.trim()}`

  useEffect(() => {
    const request = ++requestRef.current
    const timer = window.setTimeout(() => {
      // A new search replaces what is listed: rows from the previous query or
      // filter must not stay selectable while it loads.
      setList({ items: [], loadMoreFailed: false, nextCursor: null, status: 'loading', truncatedKinds: [] })
      setPreview((current) => (current.status !== 'closed' && current.scope === scope ? current : CLOSED_PREVIEW))
      api.searchProjectContext(projectId, { query: query.trim(), kinds, limit: PAGE_SIZE })
        .then((page) => {
          if (request !== requestRef.current) return
          setList({
            items: page.items.filter((item) => item.ref.kind !== 'file'),
            loadMoreFailed: false,
            nextCursor: page.next_cursor,
            status: 'ready',
            truncatedKinds: page.truncated_kinds ?? [],
          })
          setActiveIndex(0)
        })
        .catch(() => {
          if (request === requestRef.current) {
            setList({ items: [], loadMoreFailed: false, nextCursor: null, status: 'error', truncatedKinds: [] })
          }
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      // Invalidate the in-flight request when the query changes or the picker
      // unmounts, so a late response never lands in the wrong list.
      requestRef.current += 1
    }
  }, [api, kinds, projectId, query, scope])

  const rows = useMemo(
    () => list.items.filter((item) => !isOwnSessionReference(item.ref, conversationId)),
    [conversationId, list.items],
  )
  const ready = list.status === 'ready'
  const selectable = (item: ProjectContextItem | undefined) => (
    ready && Boolean(item) && item?.availability === 'available'
  )
  const enabledIndexes = rows.flatMap((item, index) => (selectable(item) ? [index] : []))
  const current = selectable(rows[activeIndex]) ? activeIndex : enabledIndexes[0] ?? -1
  const activeItem = current >= 0 ? rows[current] : undefined

  const loadMore = () => {
    if (!list.nextCursor) return
    const request = ++requestRef.current
    api.searchProjectContext(projectId, {
      query: query.trim(), kinds, limit: PAGE_SIZE, cursor: list.nextCursor,
    }).then((page) => {
      if (request !== requestRef.current) return
      setList((previous) => ({
        items: [...previous.items, ...page.items.filter((item) => item.ref.kind !== 'file')],
        loadMoreFailed: false,
        nextCursor: page.next_cursor,
        status: 'ready',
        truncatedKinds: previous.truncatedKinds,
      }))
    }).catch(() => {
      // Keep what is already listed; only the extra page failed.
      if (request === requestRef.current) {
        setList((previous) => ({ ...previous, loadMoreFailed: true }))
      }
    })
  }

  const choose = (item: ProjectContextItem) => onSelect(item)
  const openPreview = (target: ProjectContextItem) => setPreview({ scope, status: 'open', target })

  const move = (direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return
    const position = Math.max(0, enabledIndexes.indexOf(current))
    setActiveIndex(enabledIndexes[(position + direction + enabledIndexes.length) % enabledIndexes.length])
  }

  const kindLabel = (ref: ProjectContextRef) => t(PROJECT_CONTEXT_KIND_LABELS[ref.kind])
  const unavailableLabel = (item: ProjectContextItem) => t(
    item.availability === 'removed' ? 'kubecode.projectWorkRemoved' : 'kubecode.projectWorkChanged',
  )
  const closePreview = () => setPreview(CLOSED_PREVIEW)
  const hasList = ready && rows.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-2">
        <Input
          aria-activedescendant={hasList && current >= 0 ? `${listboxId}-option-${current}` : undefined}
          aria-autocomplete="list"
          aria-controls={hasList ? listboxId : undefined}
          aria-expanded={hasList}
          aria-label={t('kubecode.searchProjectWork')}
          autoFocus
          className="h-9 border-0 bg-transparent shadow-none focus-visible:ring-0"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // IME composition must never select, move, or dismiss.
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape' && preview.status !== 'closed') {
              // Escape peels the preview layer first and keeps the menu open.
              event.preventDefault()
              event.stopPropagation()
              closePreview()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'ArrowRight' && activeItem && query === '') {
              event.preventDefault()
              openPreview(activeItem)
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && activeItem) {
              event.preventDefault()
              choose(activeItem)
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
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <p className="min-w-0 text-xs text-muted-foreground">{t('kubecode.projectWorkReadOnly')}</p>
        <Button
          aria-label={t('kubecode.projectWorkPreviewSelected')}
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={!activeItem}
          onClick={() => activeItem && openPreview(activeItem)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Eye aria-hidden size={14} />
          {t('kubecode.projectWorkPreviewSelected')}
        </Button>
      </div>
      <div
        aria-busy={list.status === 'loading'}
        className="min-h-0 flex-1 overflow-y-auto p-2"
        data-testid="project-work-results"
      >
        {list.status === 'loading' ? (
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
                    'flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2',
                    index === current && 'bg-accent text-accent-foreground',
                    !enabled && 'cursor-not-allowed opacity-60',
                  )}
                  data-focus-key={`resource:${item.ref.kind}:${item.ref.id}`}
                  data-scroll-anchor={`resource:${item.ref.kind}:${item.ref.id}`}
                  id={`${listboxId}-option-${index}`}
                  key={`${item.ref.kind}:${item.ref.id}`}
                  onClick={() => enabled && choose(item)}
                  onMouseEnter={() => enabled && setActiveIndex(index)}
                  role="option"
                >
                  <FlaskConical aria-hidden className="mt-0.5 shrink-0" size={18} />
                  <span className="min-w-0">
                    <strong className="block truncate font-medium">{item.title}</strong>
                    <small className="block truncate text-xs text-muted-foreground">
                      {[
                        kindLabel(item.ref),
                        item.ref.revision && t('kubecode.projectWorkRevision', {
                          revision: item.ref.revision.slice(0, 8),
                        }),
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
                    {item.availability !== 'available' && (
                      <small className="flex items-center gap-1 text-xs text-destructive">
                        <CircleAlert aria-hidden size={12} />
                        {unavailableLabel(item)}
                      </small>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {ready && list.truncatedKinds.length > 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground" role="note">
            {t('kubecode.search.truncated', {
              kinds: new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
                .format(list.truncatedKinds.map((kind) => t(PROJECT_CONTEXT_KIND_LABELS[kind]))),
            })}
          </p>
        )}
        {ready && list.loadMoreFailed && (
          <p className="px-3 py-2 text-sm text-destructive" role="alert">
            {t('kubecode.projectWorkLoadMoreFailed')}
          </p>
        )}
        {ready && list.nextCursor && (
          <Button className="mt-1 w-full" onClick={loadMore} size="sm" type="button" variant="ghost">
            {t('kubecode.projectWorkLoadMore')}
          </Button>
        )}
      </div>
      {preview.status !== 'closed' && (
        <section
          aria-label={t('kubecode.projectWorkPreview')}
          className="max-h-56 overflow-y-auto border-t border-border p-3 text-sm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closePreview()
            }
          }}
        >
          <div className="mb-1 flex justify-end">
            <Button onClick={closePreview} size="sm" type="button" variant="ghost">
              {t('kubecode.projectWorkClosePreview')}
            </Button>
          </div>
          <div aria-live="polite">
            <RecordPreview
              api={api}
              compact
              key={`${preview.target.ref.kind}:${preview.target.ref.id}`}
              projectId={projectId}
              t={t}
              target={preview.target.ref}
              canFollow={(related) => !isOwnSessionReference(related.ref, conversationId) && related.availability === 'available'}
              onFollow={choose}
            />
          </div>
        </section>
      )}
    </div>
  )
}
