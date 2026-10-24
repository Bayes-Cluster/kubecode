import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { Translator } from '@/lib/i18n'

import { DetailPane } from '../DetailPane'
import { entryKey, parentTaskOf, type InspectorEntry, type InspectorStack } from '../location/inspector'
import {
  createInspectionRecordStore,
  InspectionRecordContext,
  InspectorEntryContext,
  InspectorServicesContext,
  type InspectorEntryApi,
  type InspectorHeader,
} from './inspectorContext'
import { focusWhenShown } from './focusWhenShown'
import type { InspectorPanels } from './inspectorPanels'
import type { InspectorPresentation } from './useInspectorPresentation'

export type InspectorPaneProps = {
  stack: InspectorStack
  presentation: InspectorPresentation
  /** The view the inspector belongs to: "General", "Kanban", a member's name. */
  originLabel: string
  projectId: string
  /** What renders each kind; the shell passes INSPECTOR_PANELS. */
  panels: InspectorPanels
  t: Translator
  onBack(): void
  onClose(): void
  onPush(entry: InspectorEntry, options?: { from?: string }): void
  onReplace(entry: InspectorEntry): void
}

/** What had focus when an entry opened the one above it. */
type Opener = { element: HTMLElement | null; from?: string }

/**
 * The one inspector of a Workspace view (ADR 0228 §3): a stack of entries in
 * a single aside. Only the top entry is shown; the ones below stay mounted,
 * parked with `inert` and `aria-hidden` (never `hidden`, which would lose
 * their scroll), so a review's selection, a typed reason, and in-flight reads
 * survive Task → evidence → Back. Each entry renders one panel with the Back
 * and Close this pane computes per presentation and depth.
 */
export function InspectorPane({
  onBack,
  onClose,
  onPush,
  onReplace,
  originLabel,
  panels,
  presentation,
  projectId,
  stack,
  t,
}: InspectorPaneProps) {
  const services = useContext(InspectorServicesContext)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const sections = useRef(new Map<string, HTMLElement>())
  const openers = useRef<Opener[]>([])
  const shownKeys = useRef<string[]>([])

  // The record of displayed versions belongs to one stack: a new root (or a
  // close) starts a new one.
  const rootKey = stack.length > 0 ? entryKey(stack[0]) : null
  const [records, setRecords] = useState(() => ({ rootKey, store: createInspectionRecordStore() }))
  if (records.rootKey !== rootKey) setRecords({ rootKey, store: createInspectionRecordStore() })

  const keys = stack.map(entryKey)
  const keysText = keys.join('\n')

  useLayoutEffect(() => {
    const now = keysText ? keysText.split('\n') : []
    const before = shownKeys.current
    shownKeys.current = now
    if (now.length === 0) {
      openers.current = []
      return
    }
    // Opening the inspector: DetailPane focuses the aside and remembers the opener.
    if (before.length === 0) return
    const topKey = now[now.length - 1]
    if (before[before.length - 1] === topKey) return
    if (before[0] !== now[0]) openers.current = []
    const section = sections.current.get(topKey)
    const wentBack = now.length < before.length && now.every((key, index) => before[index] === key)
    if (wentBack && section) {
      const opener = openers.current[now.length - 1]
      openers.current = openers.current.slice(0, now.length - 1)
      if (opener?.element?.isConnected && section.contains(opener.element)) {
        focusWhenShown(opener.element)
        return
      }
      const keyed = opener?.from
        ? Array.from(section.querySelectorAll<HTMLElement>('[data-focus-key]'))
          .find((element) => element.dataset.focusKey === opener.from)
        : undefined
      if (keyed) {
        focusWhenShown(keyed)
        return
      }
    }
    section?.focus({ preventScroll: true })
  }, [keysText])

  // The layout narrowing from beside the view to over it parks the view, and
  // focus with it: the researcher continues in the inspector, at its heading.
  const shownPresentation = useRef(presentation)
  useLayoutEffect(() => {
    const before = shownPresentation.current
    shownPresentation.current = presentation
    if (before === presentation || presentation !== 'screen' || !keysText) return
    const section = sections.current.get(keysText.split('\n').at(-1) ?? '')
    if (!section) return
    const pane = section.closest('aside') ?? section
    if (pane.contains(document.activeElement)) return
    focusHeading(section)
  }, [keysText, presentation])

  const setTitle = useCallback((key: string, text: string) => {
    setTitles((current) => (current[key] === text ? current : { ...current, [key]: text }))
  }, [])

  if (stack.length === 0) return null

  const top = stack.length - 1
  const kindLabel = (entry: InspectorEntry): string => {
    switch (entry.kind) {
      case 'task':
        return t('kubecode.nav.taskDetail')
      case 'member':
        return services?.roster.find((member) => member.id === entry.id)?.name
          ?? titles[entryKey(entry)]
          ?? t('kubecode.inspector.memberDetail')
      case 'evidence':
        return t('kubecode.inspector.evidenceDetail')
      case 'resource':
        return t('kubecode.inspector.resourceDetail')
    }
  }
  const titleOf = (index: number) => titles[keys[index]] ?? kindLabel(stack[index])
  const close = { label: t('kubecode.nav.closeDetail'), onClose }
  const headerOf = (index: number): InspectorHeader => {
    if (index > 0) {
      const back = { label: t('kubecode.inspector.backTo', { place: titleOf(index - 1) }), onBack }
      // Over the view, as on a phone, the way out is Back, one level at a time (ADR 0228 §3).
      return presentation === 'side' ? { level: 3, back, close } : { level: 3, back }
    }
    return presentation === 'side'
      ? { level: 3, close }
      : { level: 3, back: { label: t('kubecode.inspector.backTo', { place: originLabel }), onBack: onClose } }
  }

  return (
    <InspectionRecordContext.Provider value={records.store}>
      <DetailPane className="kubecode-inspector" label={kindLabel(stack[top])} onEscape={onBack}>
        {stack.map((entry, index) => {
          const key = keys[index]
          const active = index === top
          return (
            <section
              aria-hidden={active ? undefined : true}
              className="kubecode-inspector-entry"
              data-depth={index}
              data-place-scroll="inspector"
              data-top={active}
              inert={!active}
              key={key}
              ref={(element) => {
                if (element) sections.current.set(key, element)
                else sections.current.delete(key)
              }}
              tabIndex={-1}
            >
              <InspectorEntryFrame
                active={active}
                depth={index + 1}
                entry={entry}
                header={headerOf(index)}
                presentation={presentation}
                setTitle={setTitle}
                onBack={onBack}
                onClose={onClose}
                onPush={(next, options) => {
                  const element = document.activeElement instanceof HTMLElement ? document.activeElement : null
                  openers.current[index] = { element, from: options?.from }
                  onPush(next, options)
                }}
                onReplace={onReplace}
              >
                {renderPanel(panels, entry, { projectId, parentTask: parentTaskOf(stack, index), active })}
              </InspectorEntryFrame>
            </section>
          )
        })}
      </DetailPane>
    </InspectionRecordContext.Provider>
  )
}

/** Focuses an entry's heading (made focusable for it), or the entry itself. */
function focusHeading(section: HTMLElement) {
  const heading = section.querySelector<HTMLElement>('.kubecode-view-header :is(h1, h2, h3)')
  if (!heading) {
    section.focus({ preventScroll: true })
    return
  }
  if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
  heading.focus({ preventScroll: true })
}

function InspectorEntryFrame({
  active,
  children,
  depth,
  entry,
  header,
  onBack,
  onClose,
  onPush,
  onReplace,
  presentation,
  setTitle,
}: {
  active: boolean
  children: ReactNode
  depth: number
  entry: InspectorEntry
  header: InspectorHeader
  onBack(): void
  onClose(): void
  onPush(entry: InspectorEntry, options?: { from?: string }): void
  onReplace(entry: InspectorEntry): void
  presentation: InspectorPresentation
  setTitle(key: string, text: string): void
}) {
  const key = entryKey(entry)
  const titled = useCallback((text: string) => setTitle(key, text), [key, setTitle])
  const value = useMemo<InspectorEntryApi>(() => ({
    entry,
    depth,
    active,
    presentation,
    header,
    push: onPush,
    replace: onReplace,
    back: onBack,
    close: onClose,
    setTitle: titled,
  }), [active, depth, entry, header, onBack, onClose, onPush, onReplace, presentation, titled])
  return <InspectorEntryContext.Provider value={value}>{children}</InspectorEntryContext.Provider>
}

function renderPanel(
  panels: InspectorPanels,
  entry: InspectorEntry,
  props: { projectId: string; parentTask: string | null; active: boolean },
) {
  switch (entry.kind) {
    case 'task': {
      const Panel = panels.task
      return <Panel entry={entry} {...props} />
    }
    case 'member': {
      const Panel = panels.member
      return <Panel entry={entry} {...props} />
    }
    case 'evidence': {
      const Panel = panels.evidence
      return <Panel entry={entry} {...props} />
    }
    case 'resource': {
      const Panel = panels.resource
      return <Panel entry={entry} {...props} />
    }
  }
}
