import { useCallback, useEffect, useRef, useState } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CaretDown,
  Plus,
  SidebarSimple,
  SplitHorizontal,
  SplitVertical,
  TerminalWindow,
  Trash,
  X,
} from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { ResizeHandle } from '@/components/ResizeHandle'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { trackEvent } from '@/lib/telemetry'
import type { TranslationKey, TranslationValues } from '@/lib/i18n'

import type { AgentDescriptor, AgentId, KubecodeApi, TerminalInfo, TerminalKind } from './api'
import { removeTerminalSnapshot } from './terminalSnapshots'
import { TerminalView } from './TerminalView'
import { SystemMessageNotice } from './SystemMessageNotice'
import { useSystemMessages } from './systemMessages'
import {
  activateTerminalLeaf,
  closeTerminalLeaf,
  createTerminalGroup,
  readTerminalWorkspace,
  reconcileTerminalWorkspace,
  replaceTerminalLeaf,
  splitTerminalLeaf,
  terminalIds,
  updateSplitRatio,
  writeTerminalWorkspace,
  type StoredTerminalWorkspaceV2,
  type TerminalGroup,
  type TerminalLayout,
} from './terminalWorkspaceState'

type TerminalWorkspaceProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  autoCreateOnOpen?: boolean
  initialTerminals: TerminalInfo[]
  onCollapse?: () => void
  open?: boolean
  projectId: string
  t: (key: TranslationKey, values?: TranslationValues) => string
  terminalFont?: string
}

const agentKinds: Array<{ id: AgentId; kind: TerminalKind; label: string }> = [
  { id: 'claude_code', kind: 'claude_code', label: 'Claude Code' },
  { id: 'codex', kind: 'codex', label: 'Codex' },
  { id: 'opencode', kind: 'opencode', label: 'OpenCode' },
]

const TERMINAL_NAVIGATOR_NARROW = 46
const TERMINAL_NAVIGATOR_WIDE_MINIMUM = 80
const TERMINAL_NAVIGATOR_DEFAULT = 120
const TERMINAL_NAVIGATOR_MIDPOINT = 63
const TERMINAL_NAVIGATOR_MAXIMUM = 500

export function TerminalWorkspace({
  agents,
  api,
  autoCreateOnOpen = false,
  initialTerminals,
  onCollapse,
  open = true,
  projectId,
  t,
  terminalFont = 'ui-monospace, monospace',
}: TerminalWorkspaceProps) {
  const [terminals, setTerminals] = useState(initialTerminals)
  const [workspace, setWorkspace] = useState<StoredTerminalWorkspaceV2>(() => (
    readTerminalWorkspace(projectId, initialTerminals)
  ))
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const systemMessages = useSystemMessages()
  const [navigatorWidth, setNavigatorWidth] = useState(() => readTerminalNavigatorLayout(projectId).width)
  const sequence = useRef(0)
  const hadTerminal = useRef(initialTerminals.length > 0)
  const body = useRef<HTMLDivElement>(null)
  const activeGroup = workspace.groups.find((group) => group.id === workspace.activeGroupId) ?? null
  const activeTerminal = terminals.find((terminal) => terminal.id === activeGroup?.activeTerminalId) ?? null
  const navigatorVisible = terminals.length > 1
  const navigatorNarrow = navigatorWidth < TERMINAL_NAVIGATOR_MIDPOINT
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const reportError = useCallback((cause: unknown) => {
    const message = errorMessage(cause)
    if (systemMessages) {
      systemMessages.publish({ level: 'error', message, source: t('kubecode.terminal') })
    } else {
      setError(message)
    }
  }, [systemMessages, t])

  useEffect(() => writeTerminalWorkspace(projectId, workspace), [projectId, workspace])

  useEffect(() => {
    writeTerminalNavigatorLayout(projectId, { width: navigatorWidth })
  }, [navigatorWidth, projectId])

  useEffect(() => {
    setTerminals(initialTerminals)
    setWorkspace((current) => reconcileTerminalWorkspace(current, initialTerminals))
  }, [initialTerminals])

  useEffect(() => {
    if (terminals.length > 0) {
      hadTerminal.current = true
      return
    }
    if (!hadTerminal.current || workspace.groups.length > 0) return
    hadTerminal.current = false
    onCollapse?.()
  }, [onCollapse, terminals.length, workspace.groups.length])

  const create = useCallback(async (
    kind: TerminalKind,
    placement: 'group' | 'split' = 'group',
    direction: 'horizontal' | 'vertical' = 'horizontal',
  ) => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const created = await api.createTerminal(projectId, kind, 100, 28)
      setTerminals((current) => [...current, created])
      setWorkspace((current) => {
        const group = current.groups.find((item) => item.id === current.activeGroupId)
        if (placement === 'split' && group) {
          const updated = splitTerminalLeaf(
            group,
            group.activeTerminalId,
            created.id,
            direction,
            uniqueId('terminal-split', sequence),
          )
          return replaceGroup(current, updated)
        }
        const createdGroup = createTerminalGroup(uniqueId('terminal-group', sequence), created.id)
        return {
          ...current,
          activeGroupId: createdGroup.id,
          groups: [...current.groups, createdGroup],
        }
      })
      trackEvent('kubecode_terminal_created', {
        direction: placement === 'split' ? direction : 'none',
        kind,
        placement,
      })
    } catch (cause) {
      reportError(cause)
    } finally {
      setCreating(false)
    }
  }, [api, creating, projectId, reportError])

  useEffect(() => {
    if (!autoCreateOnOpen || !open || terminals.length > 0 || creating) return
    void create('regular')
  }, [autoCreateOnOpen, create, creating, open, terminals.length])

  const closeLeaf = useCallback(async (terminalId: string) => {
    setError(null)
    try {
      await api.closeTerminal(terminalId)
      removeTerminalSnapshot(projectId, terminalId)
      setTerminals((current) => current.filter((terminal) => terminal.id !== terminalId))
      setWorkspace((current) => removeTerminalFromWorkspace(current, terminalId))
      trackEvent('kubecode_terminal_closed', { scope: 'leaf' })
      if (terminals.length === 1) onCollapse?.()
    } catch (cause) {
      reportError(cause)
    }
  }, [api, onCollapse, projectId, reportError, terminals.length])

  const restart = useCallback(async (terminal: TerminalInfo) => {
    setError(null)
    try {
      const created = await api.createTerminal(projectId, terminal.kind, terminal.cols, terminal.rows)
      setTerminals((current) => [...current.filter((item) => item.id !== terminal.id), created])
      setWorkspace((current) => ({
        ...current,
        groups: current.groups.map((group) => replaceTerminalLeaf(group, terminal.id, created.id)),
      }))
      removeTerminalSnapshot(projectId, terminal.id)
      await api.closeTerminal(terminal.id)
      trackEvent('kubecode_terminal_restarted', { kind: terminal.kind })
    } catch (cause) {
      reportError(cause)
    }
  }, [api, projectId, reportError])

  const rename = useCallback(async (terminalId: string, title: string) => {
    setError(null)
    try {
      const updated = await api.updateTerminal(terminalId, title)
      setTerminals((current) => current.map((terminal) => terminal.id === updated.id ? updated : terminal))
      trackEvent('kubecode_terminal_renamed')
    } catch (cause) {
      reportError(cause)
      throw cause
    }
  }, [api, reportError])

  const activateLeaf = (terminalId: string) => {
    setWorkspace((current) => {
      const group = current.groups.find((item) => terminalIds(item.layout).includes(terminalId))
      if (!group) return current
      return {
        ...replaceGroup(current, activateTerminalLeaf(group, terminalId)),
        activeGroupId: group.id,
      }
    })
  }

  const dragGroup = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return
    setWorkspace((current) => {
      const from = current.groups.findIndex((group) => group.id === event.active.id)
      const to = current.groups.findIndex((group) => group.id === event.over?.id)
      return from < 0 || to < 0 ? current : { ...current, groups: arrayMove(current.groups, from, to) }
    })
  }

  const updateStatus = useCallback((updated: TerminalInfo) => {
    setTerminals((current) => current.map((terminal) => terminal.id === updated.id ? updated : terminal))
  }, [])

  const resizeNavigator = useCallback((delta: number) => {
    setNavigatorWidth((current) => resizeTerminalNavigator(
      current,
      delta,
      Math.min(TERMINAL_NAVIGATOR_MAXIMUM, Math.max(
        TERMINAL_NAVIGATOR_WIDE_MINIMUM,
        (body.current?.clientWidth ?? 420) - 120,
      )),
    ))
  }, [])

  const toggleNavigator = () => {
    const next = navigatorNarrow ? TERMINAL_NAVIGATOR_DEFAULT : TERMINAL_NAVIGATOR_NARROW
    setNavigatorWidth(next)
    trackEvent('kubecode_terminal_navigator_toggled', { next_state: navigatorNarrow ? 'wide' : 'narrow' })
  }

  return (
    <div className="kubecode-terminal-workspace" data-open={open}>
      <div className="kubecode-terminal-toolbar">
        <div className="kubecode-terminal-toolbar-actions">
          <Button
            aria-label={t('kubecode.newTerminal')}
            disabled={creating}
            size="icon-xs"
            variant="ghost"
            onClick={() => void create('regular')}
          ><Plus /></Button>
          <TerminalProfileMenu agents={agents} disabled={creating} onCreate={(kind) => void create(kind)} t={t} />
          <Button
            aria-label={t('kubecode.splitRight')}
            disabled={!activeTerminal || creating}
            size="icon-xs"
            variant="ghost"
            onClick={() => void create(activeTerminal?.kind ?? 'regular', 'split', 'horizontal')}
          ><SplitHorizontal /></Button>
          <Button
            aria-label={t('kubecode.splitDown')}
            disabled={!activeTerminal || creating}
            size="icon-xs"
            variant="ghost"
            onClick={() => void create(activeTerminal?.kind ?? 'regular', 'split', 'vertical')}
          ><SplitVertical /></Button>
          <Button
            aria-label={t('kubecode.closeTerminal')}
            disabled={!activeTerminal}
            size="icon-xs"
            variant="ghost"
            onClick={() => activeTerminal && void closeLeaf(activeTerminal.id)}
          ><Trash /></Button>
          {navigatorVisible && (
            <Button
              aria-label={t('kubecode.collapse')}
              aria-pressed={!navigatorNarrow}
              size="icon-xs"
              variant="ghost"
              onClick={toggleNavigator}
            ><SidebarSimple /></Button>
          )}
        </div>
      </div>
      {error && (
        <SystemMessageNotice
          className="kubecode-terminal-error"
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}
      <div className="kubecode-terminal-body" ref={body}>
        <div className="kubecode-terminal-canvas">
          {activeGroup ? (
            <TerminalLayoutView
              activeTerminalId={activeGroup.activeTerminalId}
              api={api}
              layout={activeGroup.layout}
              onActivate={activateLeaf}
              onResizeSplit={(splitId, ratio) => setWorkspace((current) => ({
                ...current,
                groups: current.groups.map((group) => group.id === activeGroup.id
                  ? { ...group, layout: updateSplitRatio(group.layout, splitId, ratio) }
                  : group),
              }))}
              onRestart={restart}
              onStatus={updateStatus}
              projectId={projectId}
              terminalFont={terminalFont}
              terminals={terminals}
              t={t}
              visible={open}
            />
          ) : (
            <div className="kubecode-empty-small">
              {creating ? t('kubecode.loading') : t('kubecode.newTerminal')}
            </div>
          )}
        </div>
        {navigatorVisible && (
          <>
            <ResizeHandle
              onDoubleClick={() => setNavigatorWidth((current) => current < TERMINAL_NAVIGATOR_MIDPOINT
                ? TERMINAL_NAVIGATOR_DEFAULT
                : TERMINAL_NAVIGATOR_NARROW)}
              onResize={resizeNavigator}
            />
            <DndContext collisionDetection={closestCenter} onDragEnd={dragGroup} sensors={sensors}>
              <SortableContext
                items={workspace.groups.map((group) => group.id)}
                strategy={verticalListSortingStrategy}
              >
                <div
                  aria-label={t('kubecode.terminal')}
                  className="kubecode-terminal-navigator"
                  data-narrow={navigatorNarrow}
                  role="tree"
                  style={{ width: navigatorWidth }}
                >
                  {workspace.groups.map((group) => (
                    <TerminalNavigatorGroup
                      activeTerminalId={activeTerminal?.id ?? null}
                      group={group}
                      key={group.id}
                      onActivate={activateLeaf}
                      onCloseTerminal={(terminalId) => void closeLeaf(terminalId)}
                      onRename={rename}
                      t={t}
                      terminals={terminals}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </>
        )}
      </div>
    </div>
  )
}

function TerminalNavigatorGroup({
  activeTerminalId,
  group,
  onActivate,
  onCloseTerminal,
  onRename,
  t,
  terminals,
}: {
  activeTerminalId: string | null
  group: TerminalGroup
  onActivate: (terminalId: string) => void
  onCloseTerminal: (terminalId: string) => void
  onRename: (terminalId: string, title: string) => Promise<void>
  t: (key: TranslationKey, values?: TranslationValues) => string
  terminals: TerminalInfo[]
}) {
  const ids = terminalIds(group.layout)
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: group.id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <div
      className="kubecode-terminal-navigator-group"
      ref={setNodeRef}
      role="none"
      style={style}
    >
      {ids.map((terminalId, index) => {
        const terminal = terminals.find((item) => item.id === terminalId)
        return terminal ? (
          <TerminalNavigatorLeaf
            active={terminalId === activeTerminalId}
            dragAttributes={index === 0 ? attributes : undefined}
            dragListeners={index === 0 ? listeners : undefined}
            key={terminalId}
            onActivate={() => onActivate(terminalId)}
            onClose={() => onCloseTerminal(terminalId)}
            onRename={onRename}
            prefix={terminalSplitPrefix(index, ids.length)}
            t={t}
            terminal={terminal}
          />
        ) : null
      })}
    </div>
  )
}

function TerminalNavigatorLeaf({
  active,
  dragAttributes,
  dragListeners,
  onActivate,
  onClose,
  onRename,
  prefix,
  t,
  terminal,
}: {
  active: boolean
  dragAttributes?: ReturnType<typeof useSortable>['attributes']
  dragListeners?: ReturnType<typeof useSortable>['listeners']
  onActivate: () => void
  onClose: () => void
  onRename: (terminalId: string, title: string) => Promise<void>
  prefix: string
  t: (key: TranslationKey, values?: TranslationValues) => string
  terminal: TerminalInfo
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(terminal.title)
  const save = async () => {
    const next = title.trim()
    if (next && next !== terminal.title) await onRename(terminal.id, next)
    setEditing(false)
  }

  return (
    <div className="kubecode-terminal-navigator-row-shell" data-active={active}>
      {editing ? (
        <TerminalNavigatorEditor
          kind={terminal.kind}
          onCancel={() => setEditing(false)}
          onChange={setTitle}
          onSave={save}
          prefix={prefix}
          t={t}
          title={title}
        />
      ) : (
        <Button
          {...dragAttributes}
          {...dragListeners}
          aria-selected={active}
          className="kubecode-terminal-navigator-row"
          data-active={active}
          role="treeitem"
          size="xs"
          variant="ghost"
          onClick={onActivate}
          onDoubleClick={() => {
            setTitle(terminal.title)
            setEditing(true)
          }}
        >
          {prefix && <span className="kubecode-terminal-split-prefix">{prefix}</span>}
          <TerminalKindIcon kind={terminal.kind} />
          <span className="kubecode-terminal-navigator-title">{terminal.title}</span>
        </Button>
      )}
      {!editing && (
        <Button
          aria-label={t('kubecode.closeTerminal')}
          className="kubecode-terminal-navigator-close"
          size="icon-xs"
          variant="ghost"
          onClick={(event) => { event.stopPropagation(); onClose() }}
          onPointerDown={(event) => event.stopPropagation()}
        ><X /></Button>
      )}
    </div>
  )
}

function TerminalNavigatorEditor({
  kind,
  onCancel,
  onChange,
  onSave,
  prefix,
  t,
  title,
}: {
  kind: TerminalKind
  onCancel: () => void
  onChange: (value: string) => void
  onSave: () => Promise<void>
  prefix: string
  t: (key: TranslationKey, values?: TranslationValues) => string
  title: string
}) {
  return (
    <div className="kubecode-terminal-navigator-editor">
      {prefix && <span className="kubecode-terminal-split-prefix">{prefix}</span>}
      <TerminalKindIcon kind={kind} />
      <Input
        aria-label={t('kubecode.terminalTitle')}
        autoFocus
        value={title}
        onBlur={() => void onSave()}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') void onSave()
          if (event.key === 'Escape') onCancel()
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
    </div>
  )
}

function TerminalProfileMenu({
  agents,
  disabled,
  onCreate,
  t,
}: {
  agents: AgentDescriptor[]
  disabled: boolean
  onCreate: (kind: TerminalKind) => void
  t: (key: TranslationKey, values?: TranslationValues) => string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={t('kubecode.terminalProfiles')} disabled={disabled} size="icon-xs" variant="ghost">
          <CaretDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('kubecode.terminal')}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onCreate('regular')}>
          <TerminalWindow /> {t('kubecode.terminal')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('kubecode.agentTui')}</DropdownMenuLabel>
        {agentKinds.map((profile) => {
          const available = agents.some((agent) => agent.id === profile.id && agent.available)
          return (
            <DropdownMenuItem disabled={!available} key={profile.id} onSelect={() => onCreate(profile.kind)}>
              <AiAgentIcon agent={profile.id} size={18} /> {profile.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TerminalLayoutView({
  activeTerminalId,
  api,
  layout,
  onActivate,
  onResizeSplit,
  onRestart,
  onStatus,
  projectId,
  terminalFont,
  terminals,
  t,
  visible,
}: {
  activeTerminalId: string
  api: KubecodeApi
  layout: TerminalLayout
  onActivate: (terminalId: string) => void
  onResizeSplit: (splitId: string, ratio: number) => void
  onRestart: (terminal: TerminalInfo) => Promise<void>
  onStatus: (terminal: TerminalInfo) => void
  projectId: string
  terminalFont: string
  terminals: TerminalInfo[]
  t: (key: TranslationKey, values?: TranslationValues) => string
  visible: boolean
}) {
  if (layout.type === 'leaf') {
    const terminal = terminals.find((item) => item.id === layout.terminalId)
    if (!terminal) return null
    return (
      <div
        className="kubecode-terminal-leaf"
        data-active={layout.terminalId === activeTerminalId}
        data-status={terminal.status}
        onMouseDown={() => onActivate(layout.terminalId)}
      >
        <TerminalView api={api} fontFamily={terminalFont} onStatus={onStatus} projectId={projectId} terminal={terminal} visible={visible} />
        {terminal.status === 'exited' && (
          <div className="kubecode-terminal-exited">
            <span>{t('kubecode.terminalExitedCode', { code: terminal.exit_code ?? '?' })}</span>
            <Button size="sm" variant="outline" onClick={() => void onRestart(terminal)}>{t('kubecode.restartTerminal')}</Button>
          </div>
        )}
      </div>
    )
  }
  return (
    <TerminalSplit
      activeTerminalId={activeTerminalId}
      api={api}
      layout={layout}
      onActivate={onActivate}
      onResizeSplit={onResizeSplit}
      onRestart={onRestart}
      onStatus={onStatus}
      projectId={projectId}
      terminalFont={terminalFont}
      t={t}
      terminals={terminals}
      visible={visible}
    />
  )
}

function TerminalSplit(props: Parameters<typeof TerminalLayoutView>[0] & {
  layout: Extract<TerminalLayout, { type: 'split' }>
}) {
  const { layout, onResizeSplit } = props
  const container = useRef<HTMLDivElement>(null)
  const resize = useCallback((delta: number) => {
    const size = layout.direction === 'horizontal'
      ? container.current?.clientWidth
      : container.current?.clientHeight
    if (!size) return
    const minimumRatio = Math.min(49, 48 / size * 100)
    onResizeSplit(layout.id, clamp(layout.ratio + delta / size * 100, minimumRatio, 100 - minimumRatio))
  }, [layout.direction, layout.id, layout.ratio, onResizeSplit])

  return (
    <div className="kubecode-terminal-split" data-split-direction={layout.direction} ref={container}>
      <div className="kubecode-terminal-split-child" style={{ flexBasis: `${layout.ratio}%` }}>
        <TerminalLayoutView {...props} layout={layout.first} />
      </div>
      <ResizeHandle
        direction={layout.direction === 'horizontal' ? 'horizontal' : 'vertical'}
        onDoubleClick={() => onResizeSplit(layout.id, 50)}
        onResize={resize}
      />
      <div className="kubecode-terminal-split-child" style={{ flexBasis: `${100 - layout.ratio}%` }}>
        <TerminalLayoutView {...props} layout={layout.second} />
      </div>
    </div>
  )
}

function TerminalKindIcon({ kind }: { kind: TerminalKind }) {
  const profile = agentKinds.find((item) => item.kind === kind)
  return profile ? <AiAgentIcon agent={profile.id} size={16} /> : <TerminalWindow />
}

function replaceGroup(
  workspace: StoredTerminalWorkspaceV2,
  group: TerminalGroup,
): StoredTerminalWorkspaceV2 {
  return {
    ...workspace,
    activeGroupId: group.id,
    groups: workspace.groups.map((item) => item.id === group.id ? group : item),
  }
}

function removeTerminalFromWorkspace(
  workspace: StoredTerminalWorkspaceV2,
  terminalId: string,
): StoredTerminalWorkspaceV2 {
  const groups = workspace.groups.flatMap((group) => closeTerminalLeaf(group, terminalId) ?? [])
  const activeGroupId = groups.some((group) => group.id === workspace.activeGroupId)
    ? workspace.activeGroupId
    : groups[0]?.id ?? null
  return { ...workspace, activeGroupId, groups }
}

function uniqueId(prefix: string, sequence: { current: number }): string {
  sequence.current += 1
  return `${prefix}-${Date.now()}-${sequence.current}`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

type TerminalNavigatorLayout = { width: number }

function readTerminalNavigatorLayout(projectId: string): TerminalNavigatorLayout {
  try {
    const stored = JSON.parse(localStorage.getItem(`kubecode:terminal-navigator:${projectId}`) ?? '{}') as {
      width?: unknown
    }
    return {
      width: typeof stored.width === 'number' && Number.isFinite(stored.width)
        ? clamp(stored.width, TERMINAL_NAVIGATOR_NARROW, TERMINAL_NAVIGATOR_MAXIMUM)
        : TERMINAL_NAVIGATOR_DEFAULT,
    }
  } catch {
    return { width: TERMINAL_NAVIGATOR_DEFAULT }
  }
}

function terminalSplitPrefix(index: number, count: number): string {
  if (count < 2) return ''
  if (index === 0) return '┌'
  return index === count - 1 ? '└' : '├'
}

function resizeTerminalNavigator(current: number, delta: number, maximum: number): number {
  if (current < TERMINAL_NAVIGATOR_MIDPOINT && delta < 0) {
    return clamp(Math.max(TERMINAL_NAVIGATOR_WIDE_MINIMUM, current - delta), TERMINAL_NAVIGATOR_WIDE_MINIMUM, maximum)
  }
  const next = current - delta
  if (next < TERMINAL_NAVIGATOR_WIDE_MINIMUM) return TERMINAL_NAVIGATOR_NARROW
  return clamp(next, TERMINAL_NAVIGATOR_WIDE_MINIMUM, maximum)
}

function writeTerminalNavigatorLayout(projectId: string, layout: TerminalNavigatorLayout): void {
  try {
    localStorage.setItem(`kubecode:terminal-navigator:${projectId}`, JSON.stringify(layout))
  } catch {
    // Restricted browser contexts can disable local storage.
  }
}
