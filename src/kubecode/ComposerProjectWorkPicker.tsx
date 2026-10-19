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
const RELATED_REFERENCES = 12

type ListState = {
  items: ProjectContextItem[]
  loadMoreFailed: boolean
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
  /**
   * Browsing instead of attaching (the Resources view): choosing a row previews
   * it, and the preview offers this action to go to the item itself.
   */
  onOpen?: (item: ProjectContextItem) => void
  /** Whether an item has somewhere to go; the Open action is offered only then. */
  canOpen?: (item: ProjectContextItem) => boolean
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
  canOpen,
  onOpen,
  onSelect,
  projectId,
  t,
}: ComposerProjectWorkPickerProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectWorkFilter>('all')
  const [list, setList] = useState<ListState>({
    items: [], loadMoreFailed: false, nextCursor: null, status: 'loading',
  })
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
      // A new search replaces what is listed: rows from the previous query or
      // filter must not stay selectable while it loads.
      setList({ items: [], loadMoreFailed: false, nextCursor: null, status: 'loading' })
      setPreview({ status: 'closed' })
      api.searchProjectContext(projectId, { query: query.trim(), kinds, limit: PAGE_SIZE })
        .then((page) => {
          if (request !== requestRef.current) return
          setList({
            items: page.items, loadMoreFailed: false, nextCursor: page.next_cursor, status: 'ready',
          })
          setActiveIndex(0)
        })
        .catch(() => {
          if (request === requestRef.current) {
            setList({ items: [], loadMoreFailed: false, nextCursor: null, status: 'error' })
          }
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      // Invalidate the in-flight request when the query changes or the picker
      // unmounts, so a late response never lands in the wrong list.
      requestRef.current += 1
      previewRequestRef.current += 1
    }
  }, [api, kinds, projectId, query])

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
        items: [...previous.items, ...page.items],
        loadMoreFailed: false,
        nextCursor: page.next_cursor,
        status: 'ready',
      }))
    }).catch(() => {
      // Keep what is already listed; only the extra page failed.
      if (request === requestRef.current) {
        setList((previous) => ({ ...previous, loadMoreFailed: true }))
      }
    })
  }

  const browsing = onOpen !== undefined
  const choose = (item: ProjectContextItem) => {
    if (browsing) openPreview(item)
    else onSelect(item)
  }

  function openPreview(target: ProjectContextItem) {
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
  const unavailableLabel = (item: ProjectContextItem) => t(
    item.availability === 'removed' ? 'kubecode.projectWorkRemoved' : 'kubecode.projectWorkChanged',
  )
  const closePreview = () => setPreview({ status: 'closed' })
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
          autoFocus={!browsing}
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
            } else if (
              // Browsing is not attaching: there Tab keeps moving focus.
              (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && !browsing)) && activeItem
            ) {
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
          <div className="mb-1 flex items-center justify-between gap-2">
            <strong className="min-w-0 truncate">{preview.target.title}</strong>
            {onOpen && canOpen?.(preview.target) !== false && (
              <Button onClick={() => onOpen(preview.target)} size="sm" type="button" variant="outline">
                {t('kubecode.resources.open')}
              </Button>
            )}
            <Button onClick={closePreview} size="sm" type="button" variant="ghost">
              {t('kubecode.projectWorkClosePreview')}
            </Button>
          </div>
          <div aria-live="polite">
            {preview.status === 'loading' ? (
              <p className="text-muted-foreground" role="status">{t('kubecode.loadingContext')}</p>
            ) : preview.status === 'error' ? (
              <p className="text-destructive" role="alert">{t('kubecode.projectWorkPreviewFailed')}</p>
            ) : (
              <>
                <p className="mb-1 text-xs text-muted-foreground">
                  {[
                    kindLabel(preview.document.ref),
                    preview.document.ref.revision && t('kubecode.projectWorkRevision', {
                      revision: preview.document.ref.revision.slice(0, 8),
                    }),
                    preview.document.availability !== 'available'
                      && unavailableLabel({ ...preview.target, availability: preview.document.availability }),
                  ].filter(Boolean).join(' · ')}
                </p>
                {preview.document.sections.map((section, index) => (
                  <div className="mb-2" key={`${index}:${section.heading}`}>
                    <h4 className="text-xs font-medium text-muted-foreground">{section.heading}</h4>
                    <p className="whitespace-pre-wrap break-words">{section.text}</p>
                  </div>
                ))}
                {preview.document.notes.map((note, index) => (
                  <p className="text-xs text-muted-foreground" key={`${index}:${note}`}>{note}</p>
                ))}
                {preview.document.related.filter((related) => (
                  !isOwnSessionReference(related.ref, conversationId)
                  && related.availability === 'available'
                )).slice(0, RELATED_REFERENCES).map((related) => (
                  <Button
                    className="h-auto w-full justify-start px-2 py-1.5 text-left"
                    key={`${related.ref.kind}:${related.ref.id}`}
                    onClick={() => choose(related)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <span className="min-w-0 truncate">
                      {t('kubecode.projectWorkReferenceItem', {
                        kind: kindLabel(related.ref),
                        title: related.title,
                      })}
                    </span>
                  </Button>
                ))}
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
