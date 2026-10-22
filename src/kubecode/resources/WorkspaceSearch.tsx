import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { KubecodeApi, ProjectContextKind, WorkspaceEvent } from '../api'
import { usePlaceState } from '../app/location/placeMemory'
import { objectKindOf } from '../references/referenceLabels'
import { resourceFocusKey } from './referenceKinds'
import { resultMeta } from './resultMeta'
import {
  DEFAULT_SECTIONS,
  RESOURCE_SECTION_ORDER,
  RESOURCE_SECTIONS,
  describeScope,
  kindsFor,
  sectionList,
  sectionsSearched,
  type ResourceSection,
} from './searchScope'
import { useWorkspaceSearch, type SearchResult, type WorkspaceSearchState } from './useWorkspaceSearch'

export type WorkspaceSearchProps = {
  /** `browse` (Resources) and `quick` (titlebar) preview a result; `attach` (Add context) attaches on Enter. */
  mode: 'browse' | 'attach' | 'quick'
  api: KubecodeApi
  projectId: string
  workspaceName: string
  t: Translator
  locale?: string
  events: readonly WorkspaceEvent[]
  /** Where the place keeps the words, sections, active row, and results (page memory only). */
  memoryKey: string
  /** A result was chosen (click, Enter, or → in attach mode); `focusKey` is the row's `data-focus-key`. */
  onChoose: (result: SearchResult, focusKey: string) => void
  /** Attach mode: Enter attaches the current version. */
  onAttachCurrent?: (result: SearchResult) => void
  /** Escape with nothing to clear: the host closes or steps back. */
  onEscape?: () => void
  /** Reports the list's state, so a host can restore its scroll once results are in. */
  onStatusChange?: (status: WorkspaceSearchState['status']) => void
  /** The result shown in the host's preview. */
  selectedKey?: string | null
  /** The Task a record belongs to, by id. */
  taskTitle?: (id: string) => string | undefined
  limit?: number
  autoFocus?: boolean
  listRef?: Ref<HTMLDivElement>
  /** Names the search box for focus return (`data-focus-key`). */
  inputFocusKey?: string
  /** Below the results (Quick: "See all results in Resources"). */
  footer?: ReactNode
  debounceMs?: number
}

const QUICK_LIMIT = 8

/**
 * The one Workspace search (ADR 0231 §2): a combobox over explicit sections
 * whose scope is said in words, results that name their kind, version, state
 * and Task, and the same keyboard everywhere. It never navigates: the host
 * decides what choosing a result does.
 */
export function WorkspaceSearch({
  api,
  autoFocus = false,
  debounceMs,
  events,
  footer,
  inputFocusKey,
  limit,
  listRef,
  locale,
  memoryKey,
  mode,
  onAttachCurrent,
  onChoose,
  onEscape,
  onStatusChange,
  projectId,
  selectedKey = null,
  t,
  taskTitle,
  workspaceName,
}: WorkspaceSearchProps) {
  const [query, setQuery] = usePlaceState(`${memoryKey}#query`, '')
  const [chosenSections, setSections] = usePlaceState<ResourceSection[]>(`${memoryKey}#sections`, DEFAULT_SECTIONS)
  const [activeKey, setActiveKey] = usePlaceState<string | null>(`${memoryKey}#active`, null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const sections = mode === 'quick' ? DEFAULT_SECTIONS : chosenSections
  const kinds = kindsFor(sections)
  const search = useWorkspaceSearch({
    api,
    projectId,
    query,
    kinds,
    cacheKey: memoryKey,
    events,
    pageSize: limit ?? (mode === 'quick' ? QUICK_LIMIT : undefined),
    debounceMs,
  })
  const { results, status } = search
  useEffect(() => { onStatusChange?.(status) }, [onStatusChange, status])
  const listboxId = useId()
  const scopeId = useId()
  const optionId = (key: string) => `${listboxId}-${encodeURIComponent(key).replace(/%/g, '_')}`
  const activeIndex = Math.max(0, results.findIndex((entry) => entry.key === activeKey))
  const active = results.length > 0 ? results[activeIndex] : undefined
  const ready = status === 'ready'

  const move = (to: number) => {
    if (results.length === 0) return
    const index = Math.min(results.length - 1, Math.max(0, to))
    setActiveKey(results[index].key)
    setRefusal(null)
    document.getElementById(optionId(results[index].key))?.scrollIntoView?.({ block: 'nearest' })
  }
  const choose = (result: SearchResult) => {
    setActiveKey(result.key)
    setRefusal(null)
    onChoose(result, resourceFocusKey(result.item.ref))
  }
  const attach = (result: SearchResult) => {
    if (result.item.availability === 'removed') {
      setRefusal(t('kubecode.resources.removedCannotAdd'))
      return
    }
    setRefusal(null)
    onAttachCurrent?.(result)
  }
  const toggle = (section: ResourceSection) => {
    setActiveKey(null)
    setSections((current) => (current.includes(section)
      ? current.filter((entry) => entry !== section)
      : RESOURCE_SECTION_ORDER.filter((entry) => entry === section || current.includes(entry))))
  }

  const sectionCount = (section: ResourceSection) => {
    const sectionKinds = RESOURCE_SECTIONS[section].kinds
    if (!ready || !sectionKinds.some((kind) => search.searched.includes(kind) || kind in search.counts)) return null
    const count = sectionKinds.reduce((total, kind) => total + (search.counts[kind] ?? 0), 0)
    const more = sectionKinds.some((kind) => search.truncatedKinds.includes(kind))
    return { count, more }
  }
  const truncatedSections = RESOURCE_SECTION_ORDER.filter((section) => (
    sections.includes(section) && RESOURCE_SECTIONS[section].kinds.some((kind: ProjectContextKind) => search.truncatedKinds.includes(kind))
  ))
  const words = query.trim()
  // The scope in words is what the server reports it searched; until it answers, what was asked for.
  const reported = ready && search.searched.length > 0 ? sectionsSearched(search.searched) : sections
  // The walk's limits matter when they could explain a missing file: nothing found, or files cut short.
  const filesNote = sections.includes('files') && ready && (results.length === 0 || search.truncatedKinds.includes('file'))
  const input = useRef<HTMLInputElement>(null)

  return (
    <div className={cn('kubecode-ws-search-host', `kubecode-ws-search-host-${mode}`)} data-ws-components="official">
      <div className="kubecode-ws-search">
        <div className="kubecode-ws-search-field">
          <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.search.Icon} />
          <Input
            aria-activedescendant={active ? optionId(active.key) : undefined}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-describedby={scopeId}
            aria-expanded={results.length > 0}
            aria-label={t('kubecode.search.label', { workspace: workspaceName })}
            autoFocus={autoFocus}
            data-focus-key={inputFocusKey}
            placeholder={t('kubecode.search.placeholder')}
            ref={input}
            role="combobox"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveKey(null)
              setRefusal(null)
            }}
            onKeyDown={(event) => {
              // IME composition must never move, choose, or dismiss.
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                move(activeIndex + 1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                move(activeIndex - 1)
              } else if (event.key === 'Home' && results.length > 0 && query === '') {
                event.preventDefault()
                move(0)
              } else if (event.key === 'End' && results.length > 0 && query === '') {
                event.preventDefault()
                move(results.length - 1)
              } else if (event.key === 'Enter' && active && ready) {
                event.preventDefault()
                if (mode === 'attach') attach(active)
                else choose(active)
              } else if (event.key === 'ArrowRight' && mode === 'attach' && active && ready
                && event.currentTarget.selectionStart === query.length) {
                event.preventDefault()
                choose(active)
              } else if (event.key === 'Escape') {
                if (query !== '') {
                  event.preventDefault()
                  event.stopPropagation()
                  setQuery('')
                  setActiveKey(null)
                } else if (onEscape) {
                  event.preventDefault()
                  event.stopPropagation()
                  onEscape()
                }
              }
            }}
          />
        </div>
        {mode !== 'quick' && (
          <div aria-label={t('kubecode.search.sectionsLabel')} className="kubecode-ws-search-sections" role="group">
            {RESOURCE_SECTION_ORDER.map((section) => {
              const pressed = sections.includes(section)
              const counted = pressed ? sectionCount(section) : null
              const label = t(RESOURCE_SECTIONS[section].label)
              return (
                <Button
                  aria-label={counted
                    ? t(counted.more ? 'kubecode.search.sectionCountMore' : 'kubecode.search.sectionCount', { section: label, count: counted.count })
                    : label}
                  aria-pressed={pressed}
                  className="kubecode-ws-search-section"
                  key={section}
                  size="sm"
                  type="button"
                  variant={pressed ? 'secondary' : 'ghost'}
                  onClick={() => toggle(section)}
                >
                  <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[RESOURCE_SECTIONS[section].icon].Icon} />
                  <span>{label}</span>
                  {counted && (
                    <span className="kubecode-ws-search-count">
                      {counted.more ? t('kubecode.search.countMore', { count: counted.count }) : counted.count}
                    </span>
                  )}
                </Button>
              )
            })}
          </div>
        )}
        <p className="kubecode-ws-search-scope" id={scopeId} role="note">
          {reported.length > 0 && <span>{describeScope(reported, workspaceName, t, locale ?? 'en')} </span>}
          <span>{t('kubecode.search.scopeMatch')} </span>
          <span>{t('kubecode.search.privateExcluded')}</span>
        </p>
        {filesNote && (
          <p className="kubecode-ws-search-notice">{t('kubecode.search.filesSkipped')}</p>
        )}
        {ready && truncatedSections.length > 0 && (
          <p className="kubecode-ws-search-notice">
            {t('kubecode.search.truncated', { kinds: sectionList(truncatedSections, t, locale ?? 'en') })}
          </p>
        )}
        {search.stale && (
          <p className="kubecode-ws-search-notice" role="status">
            {t('kubecode.search.stale')}{' '}
            <Button size="xs" variant="outline" onClick={search.refresh}>{t('kubecode.search.refresh')}</Button>
          </p>
        )}
        {refusal && <p className="kubecode-research-error" role="alert">{refusal}</p>}
      </div>
      <div aria-busy={status === 'loading'} className="kubecode-ws-search-results" data-testid="search-results" ref={listRef}>
        {status === 'idle' ? (
          <p className="kubecode-research-muted" role="status">{t('kubecode.search.noSections')}</p>
        ) : status === 'loading' ? (
          <p className="kubecode-research-muted" role="status">{t('kubecode.search.loading')}</p>
        ) : status === 'error' ? (
          <p className="kubecode-research-error" role="alert">
            {t('kubecode.search.failed')}{' '}
            <Button size="xs" variant="ghost" onClick={search.retry}>{t('kubecode.vocab.command.retry')}</Button>
          </p>
        ) : results.length === 0 ? (
          <div className="kubecode-research-muted" role="status">
            {words ? (
              <>
                <p>{t('kubecode.search.empty', { sections: sectionList(sections, t, locale ?? 'en'), query: words })}</p>
                <p>{t('kubecode.search.emptyHint')}</p>
              </>
            ) : (
              <p>{t('kubecode.search.emptyRecent')}</p>
            )}
          </div>
        ) : null}
        <ul aria-label={t('kubecode.search.results')} className="kubecode-ws-search-list" id={listboxId} role="listbox">
          {results.map((result) => {
            const { item } = result
            const focusKey = resourceFocusKey(item.ref)
            return (
              <Item asChild key={result.key} size="sm">
              <li
                aria-selected={result.key === selectedKey}
                className="kubecode-resource-row"
                data-active={result === active ? true : undefined}
                data-availability={item.availability}
                data-focus-key={focusKey}
                data-scroll-anchor={focusKey}
                id={optionId(result.key)}
                role="option"
                tabIndex={-1}
                onClick={() => choose(result)}
                onFocus={() => {
                  // Focus returned to a row (after Back) belongs to the search box, with this row active.
                  setActiveKey(result.key)
                  input.current?.focus({ preventScroll: true })
                }}
              >
                <ItemMedia>
                  <Icon role="identity" source={WORKSPACE_OBJECT_ICONS[objectKindOf(item.ref.kind)].Icon} />
                </ItemMedia>
                <ItemContent className="kubecode-resource-row-body">
                  <ItemTitle className="kubecode-resource-row-title">{item.title}</ItemTitle>
                  <ItemDescription className="kubecode-resource-row-meta">
                    {resultMeta(item, t, { locale, taskTitle }).join(' · ')}
                  </ItemDescription>
                  {item.summary && <ItemDescription className="kubecode-resource-row-summary">{item.summary}</ItemDescription>}
                </ItemContent>
              </li>
              </Item>
            )
          })}
        </ul>
        {ready && search.loadMoreFailed && (
          <p className="kubecode-research-error" role="alert">{t('kubecode.projectWorkLoadMoreFailed')}</p>
        )}
        {ready && search.nextCursor && mode !== 'quick' && (
          <Button className="kubecode-ws-search-more" size="sm" type="button" variant="ghost" onClick={search.loadMore}>
            {t('kubecode.projectWorkLoadMore')}
          </Button>
        )}
        {footer}
      </div>
    </div>
  )
}
