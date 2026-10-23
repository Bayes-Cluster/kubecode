import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'

import { CheckIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { KubecodeApi, ProjectContextKind, WorkspaceEvent } from '../api'
import { usePlaceState } from '../app/location/placeMemory'
import { objectKindOf } from '../references/referenceLabels'
import { ReaderEmpty, ReaderLoading, ReaderNotice } from './ReaderStates'
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
  const scopeId = useId()
  const activeIndex = Math.max(0, results.findIndex((entry) => entry.key === activeKey))
  const active = results.length > 0 ? results[activeIndex] : undefined
  const ready = status === 'ready'

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
  const countLabel = (counted: { count: number; more: boolean }) => (
    counted.more ? t('kubecode.search.countMore', { count: counted.count }) : String(counted.count)
  )

  return (
    // The official Command (cmdk) owns the combobox, the listbox, the active row, and the arrow keys.
    // The server ranks and pages the results, so Command neither filters nor sorts them.
    <Command
      className="min-h-0 min-w-0 flex-1 gap-2"
      data-mode={mode}
      label={t('kubecode.search.label', { workspace: workspaceName })}
      loop={false}
      shouldFilter={false}
      value={active?.key ?? ''}
      onValueChange={(key) => {
        setActiveKey(key || null)
        setRefusal(null)
      }}
    >
      <div className="flex flex-col gap-2">
        <CommandInput
          aria-describedby={scopeId}
          autoFocus={autoFocus}
          data-focus-key={inputFocusKey}
          placeholder={t('kubecode.search.placeholder')}
          ref={input}
          value={query}
          onValueChange={(next) => {
            setQuery(next)
            setActiveKey(null)
            setRefusal(null)
          }}
          onKeyDown={(event) => {
            // IME composition never moves, chooses, or dismisses (Command ignores it too).
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if ((event.key === 'Home' || event.key === 'End') && query !== '') {
              // With words typed, Home and End move the caret, not the active row.
              event.stopPropagation()
            } else if (event.key === 'Enter') {
              // Command would choose; here attach mode attaches, and nothing happens until results are in.
              event.preventDefault()
              if (!active || !ready) return
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
        {mode !== 'quick' && (
          <ToggleGroup
            aria-label={t('kubecode.search.sectionsLabel')}
            className="w-full justify-start max-sm:overflow-x-auto sm:flex-wrap"
            size="sm"
            spacing={1}
            type="multiple"
            value={sections}
            variant="outline"
            onValueChange={(next: string[]) => {
              const chosen = RESOURCE_SECTION_ORDER.filter((section) => next.includes(section))
              const changed = RESOURCE_SECTION_ORDER.find((section) => chosen.includes(section) !== sections.includes(section))
              if (changed) toggle(changed)
            }}
          >
            {RESOURCE_SECTION_ORDER.map((section) => {
              const counted = sections.includes(section) ? sectionCount(section) : null
              const label = t(RESOURCE_SECTIONS[section].label)
              return (
                <ToggleGroupItem
                  aria-label={counted
                    ? t(counted.more ? 'kubecode.search.sectionCountMore' : 'kubecode.search.sectionCount', { section: label, count: counted.count })
                    : label}
                  className="shrink-0 pointer-coarse:min-h-[44px]"
                  key={section}
                  value={section}
                >
                  <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[RESOURCE_SECTIONS[section].icon].Icon} />
                  <span>{label}</span>
                  {counted && <Badge className="tabular-nums" variant="secondary">{countLabel(counted)}</Badge>}
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        )}
        <p className="text-xs text-muted-foreground" id={scopeId} role="note">
          {reported.length > 0 && <span>{describeScope(reported, workspaceName, t, locale ?? 'en')} </span>}
          <span>{t('kubecode.search.scopeMatch')} </span>
          <span>{t('kubecode.search.privateExcluded')}</span>
        </p>
        {filesNote && <ReaderNotice live={false}>{t('kubecode.search.filesSkipped')}</ReaderNotice>}
        {ready && truncatedSections.length > 0 && (
          <ReaderNotice live={false}>
            {t('kubecode.search.truncated', { kinds: sectionList(truncatedSections, t, locale ?? 'en') })}
          </ReaderNotice>
        )}
        {search.stale && (
          <ReaderNotice action={<Button size="xs" variant="outline" onClick={search.refresh}>{t('kubecode.search.refresh')}</Button>}>
            {t('kubecode.search.stale')}
          </ReaderNotice>
        )}
        {refusal && <ReaderNotice failed>{refusal}</ReaderNotice>}
      </div>
      <div
        aria-busy={status === 'loading'}
        className={cn('flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto', mode === 'attach' && 'max-h-[50vh]')}
        data-testid="search-results" ref={listRef}>
        {status === 'idle' ? (
          <ReaderEmpty>{t('kubecode.search.noSections')}</ReaderEmpty>
        ) : status === 'loading' ? (
          <ReaderLoading>{t('kubecode.search.loading')}</ReaderLoading>
        ) : status === 'error' ? (
          <ReaderNotice
            action={<Button size="xs" variant="outline" onClick={search.retry}>{t('kubecode.vocab.command.retry')}</Button>}
            failed
          >
            {t('kubecode.search.failed')}
          </ReaderNotice>
        ) : results.length === 0 ? (
          <ReaderEmpty>
            {words ? (
              <>
                <span className="block">{t('kubecode.search.empty', { sections: sectionList(sections, t, locale ?? 'en'), query: words })}</span>
                <span className="block">{t('kubecode.search.emptyHint')}</span>
              </>
            ) : t('kubecode.search.emptyRecent')}
          </ReaderEmpty>
        ) : null}
        <CommandList label={t('kubecode.search.results')} className="max-h-none overflow-visible">
          {results.length > 0 && (
            <CommandGroup>
              {results.map((result) => {
                const { item } = result
                const focusKey = resourceFocusKey(item.ref)
                const removed = item.availability === 'removed'
                return (
                  <CommandItem
                    className="items-start gap-3"
                    data-availability={item.availability}
                    aria-current={result.key === selectedKey ? 'true' : undefined}
                    data-focus-key={focusKey}
                    data-scroll-anchor={focusKey}
                    key={result.key}
                    tabIndex={-1}
                    value={result.key}
                    onFocus={(event) => {
                      // Focus returned to a row (after Back) belongs to the search box, with this row active.
                      // cmdk only announces an active row it chose itself (a controlled value does not update
                      // aria-activedescendant), so the row is made active the way a pointer would.
                      event.currentTarget.dispatchEvent(new Event('pointermove', { bubbles: true }))
                      input.current?.focus({ preventScroll: true })
                    }}
                    onSelect={() => choose(result)}
                  >
                    <ItemMedia className="mt-0.5">
                      <Icon role="identity" source={WORKSPACE_OBJECT_ICONS[objectKindOf(item.ref.kind)].Icon} />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className={cn('break-words', removed && 'line-through')}>{item.title}</ItemTitle>
                      <ItemDescription className="break-words">
                        {resultMeta(item, t, { locale, taskTitle }).join(' · ')}
                      </ItemDescription>
                      {item.summary && <ItemDescription className="truncate">{item.summary}</ItemDescription>}
                    </ItemContent>
                    {result.key === selectedKey && <CheckIcon aria-hidden="true" className="ml-auto" />}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )}
        </CommandList>
        {ready && search.loadMoreFailed && (
          <ReaderNotice
            action={<Button size="xs" variant="outline" onClick={search.loadMore}>{t('kubecode.vocab.command.retry')}</Button>}
            failed
          >
            {t('kubecode.projectWorkLoadMoreFailed')}
          </ReaderNotice>
        )}
        {ready && search.nextCursor && !search.loadMoreFailed && mode !== 'quick' && (
          <Button className="w-full" size="sm" type="button" variant="ghost" onClick={search.loadMore}>
            {t('kubecode.projectWorkLoadMore')}
          </Button>
        )}
        {footer}
      </div>
    </Command>
  )
}
