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
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CaretDown,
  Plus,
  SplitHorizontal,
  SplitVertical,
  TerminalWindow,
  X,
} from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { ResizeHandle } from '@/components/ResizeHandle'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
}

const agentKinds: Array<{ id: AgentId; kind: TerminalKind; label: string }> = [
  { id: 'claude_code', kind: 'claude_code', label: 'Claude Code' },
  { id: 'codex', kind: 'codex', label: 'Codex' },
  { id: 'opencode', kind: 'opencode', label: 'OpenCode' },
]

export function TerminalWorkspace({
  agents,
  api,
  autoCreateOnOpen = false,
  initialTerminals,
  onCollapse,
  open = true,
  projectId,
  t,
}: TerminalWorkspaceProps) {
  const [terminals, setTerminals] = useState(initialTerminals)
  const [workspace, setWorkspace] = useState<StoredTerminalWorkspaceV2>(() => (
    readTerminalWorkspace(projectId, initialTerminals)
  ))
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closingGroupId, setClosingGroupId] = useState<string | null>(null)
  const sequence = useRef(0)
  const activeGroup = workspace.groups.find((group) => group.id === workspace.activeGroupId) ?? null
  const activeTerminal = terminals.find((terminal) => terminal.id === activeGroup?.activeTerminalId) ?? null
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => writeTerminalWorkspace(projectId, workspace), [projectId, workspace])

  useEffect(() => {
    setTerminals(initialTerminals)
    setWorkspace((current) => reconcileTerminalWorkspace(current, initialTerminals))
  }, [initialTerminals])

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
      setError(errorMessage(cause))
    } finally {
      setCreating(false)
    }
  }, [api, creating, projectId])

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
      setError(errorMessage(cause))
    }
  }, [api, onCollapse, projectId, terminals.length])

  const closeGroup = useCallback(async (groupId: string) => {
    const group = workspace.groups.find((item) => item.id === groupId)
    if (!group) return
    setError(null)
    try {
      const ids = terminalIds(group.layout)
      await Promise.all(ids.map((terminalId) => api.closeTerminal(terminalId)))
      ids.forEach((terminalId) => removeTerminalSnapshot(projectId, terminalId))
      setTerminals((current) => current.filter((terminal) => !ids.includes(terminal.id)))
      setWorkspace((current) => removeGroup(current, groupId))
      setClosingGroupId(null)
      trackEvent('kubecode_terminal_closed', { scope: 'group' })
      if (ids.length === terminals.length) onCollapse?.()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [api, onCollapse, projectId, terminals.length, workspace.groups])

  const requestCloseGroup = (group: TerminalGroup) => {
    if (terminalIds(group.layout).length === 1) {
      void closeGroup(group.id)
      return
    }
    setClosingGroupId(group.id)
  }

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
      setError(errorMessage(cause))
    }
  }, [api, projectId])

  const rename = useCallback(async (terminalId: string, title: string) => {
    setError(null)
    try {
      const updated = await api.updateTerminal(terminalId, title)
      setTerminals((current) => current.map((terminal) => terminal.id === updated.id ? updated : terminal))
      trackEvent('kubecode_terminal_renamed')
    } catch (cause) {
      setError(errorMessage(cause))
      throw cause
    }
  }, [api])

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

  return (
    <div className="kubecode-terminal-workspace" data-open={open}>
      <div className="kubecode-terminal-toolbar">
        <TerminalWindow className="kubecode-terminal-toolbar-icon" />
        <DndContext collisionDetection={closestCenter} onDragEnd={dragGroup} sensors={sensors}>
          <SortableContext
            items={workspace.groups.map((group) => group.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="kubecode-terminal-tabs" role="tablist">
              {workspace.groups.map((group) => (
                <TerminalGroupTab
                  active={group.id === workspace.activeGroupId}
                  group={group}
                  key={group.id}
                  onActivate={() => setWorkspace((current) => ({ ...current, activeGroupId: group.id }))}
                  onClose={() => requestCloseGroup(group)}
                  onRename={rename}
                  t={t}
                  terminals={terminals}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
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
          ><X /></Button>
          <Button
            aria-label={t('kubecode.collapse')}
            size="icon-xs"
            variant="ghost"
            onClick={onCollapse}
          ><CaretDown /></Button>
        </div>
      </div>
      {error && <div className="kubecode-terminal-error" role="alert">{error}</div>}
      {activeGroup ? (
        <TerminalLayoutView
          activeTerminalId={activeGroup.activeTerminalId}
          api={api}
          layout={activeGroup.layout}
          onActivate={activateLeaf}
          onClose={closeLeaf}
          onResizeSplit={(splitId, ratio) => setWorkspace((current) => ({
            ...current,
            groups: current.groups.map((group) => group.id === activeGroup.id
              ? { ...group, layout: updateSplitRatio(group.layout, splitId, ratio) }
              : group),
          }))}
          onRestart={restart}
          onStatus={updateStatus}
          projectId={projectId}
          showLeafHeaders={terminalIds(activeGroup.layout).length > 1}
          terminals={terminals}
          t={t}
          visible={open}
        />
      ) : (
        <div className="kubecode-empty-small">{creating ? t('kubecode.loading') : t('kubecode.newTerminal')}</div>
      )}
      <Dialog open={closingGroupId !== null} onOpenChange={(next) => !next && setClosingGroupId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.closeTerminalGroup')}</DialogTitle>
            <DialogDescription>{t('kubecode.closeTerminalGroupDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">{t('common.cancel')}</Button></DialogClose>
            <Button variant="destructive" onClick={() => closingGroupId && void closeGroup(closingGroupId)}>
              {t('kubecode.closeTerminalGroup')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TerminalGroupTab({
  active,
  group,
  onActivate,
  onClose,
  onRename,
  t,
  terminals,
}: {
  active: boolean
  group: TerminalGroup
  onActivate: () => void
  onClose: () => void
  onRename: (terminalId: string, title: string) => Promise<void>
  t: (key: TranslationKey, values?: TranslationValues) => string
  terminals: TerminalInfo[]
}) {
  const [editing, setEditing] = useState(false)
  const activeTerminal = terminals.find((terminal) => terminal.id === group.activeTerminalId)
  const [title, setTitle] = useState(activeTerminal?.title ?? '')
  const count = terminalIds(group.layout).length
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: group.id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  const save = async () => {
    const next = title.trim()
    if (activeTerminal && next && next !== activeTerminal.title) await onRename(activeTerminal.id, next)
    setEditing(false)
  }

  return (
    <div
      className="kubecode-terminal-group-tab-shell"
      data-active={active}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      {editing ? (
        <div className="kubecode-terminal-group-tab kubecode-terminal-group-tab-editing">
        <TerminalKindIcon kind={activeTerminal?.kind ?? 'regular'} />
        <Input
          aria-label={t('kubecode.terminalTitle')}
          autoFocus
          value={title}
          onBlur={() => void save()}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') void save()
            if (event.key === 'Escape') setEditing(false)
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
        {count > 1 && <small>{count}</small>}
        </div>
      ) : (
        <Button
          aria-selected={active}
          className="kubecode-terminal-group-tab"
          role="tab"
          size="xs"
          variant={active ? 'secondary' : 'ghost'}
          onClick={onActivate}
          onDoubleClick={() => {
            setTitle(activeTerminal?.title ?? '')
            setEditing(true)
          }}
        >
          <TerminalKindIcon kind={activeTerminal?.kind ?? 'regular'} />
          <span>{activeTerminal?.title ?? t('kubecode.terminal')}</span>
          {count > 1 && <small>{count}</small>}
        </Button>
      )}
      <Button
        aria-label={t('kubecode.closeTerminalGroup')}
        className="kubecode-terminal-tab-close"
        size="icon-xs"
        variant="ghost"
        onClick={(event) => { event.stopPropagation(); onClose() }}
        onPointerDown={(event) => event.stopPropagation()}
      ><X /></Button>
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
              <AiAgentIcon agent={profile.id} size={16} /> {profile.label}
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
  onClose,
  onResizeSplit,
  onRestart,
  onStatus,
  projectId,
  showLeafHeaders,
  terminals,
  t,
  visible,
}: {
  activeTerminalId: string
  api: KubecodeApi
  layout: TerminalLayout
  onActivate: (terminalId: string) => void
  onClose: (terminalId: string) => Promise<void>
  onResizeSplit: (splitId: string, ratio: number) => void
  onRestart: (terminal: TerminalInfo) => Promise<void>
  onStatus: (terminal: TerminalInfo) => void
  projectId: string
  showLeafHeaders: boolean
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
        {showLeafHeaders && (
          <div className="kubecode-terminal-leaf-header">
            <TerminalKindIcon kind={terminal.kind} />
            <span>{terminal.title}</span>
            {terminal.status === 'exited' && <small>{t('kubecode.terminalExited')}</small>}
            {terminal.status === 'exited' && (
              <Button size="xs" variant="ghost" onClick={() => void onRestart(terminal)}>{t('kubecode.restartTerminal')}</Button>
            )}
            <Button aria-label={t('kubecode.closeTerminal')} size="icon-xs" variant="ghost" onClick={() => void onClose(terminal.id)}>
              <X />
            </Button>
          </div>
        )}
        <TerminalView api={api} onStatus={onStatus} projectId={projectId} terminal={terminal} visible={visible} />
        {terminal.status === 'exited' && !showLeafHeaders && (
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
      onClose={onClose}
      onResizeSplit={onResizeSplit}
      onRestart={onRestart}
      onStatus={onStatus}
      projectId={projectId}
      showLeafHeaders={showLeafHeaders}
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
  return profile ? <AiAgentIcon agent={profile.id} size={14} /> : <TerminalWindow />
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

function removeGroup(
  workspace: StoredTerminalWorkspaceV2,
  groupId: string,
): StoredTerminalWorkspaceV2 {
  const groups = workspace.groups.filter((group) => group.id !== groupId)
  return {
    ...workspace,
    activeGroupId: workspace.activeGroupId === groupId ? groups[0]?.id ?? null : workspace.activeGroupId,
    groups,
  }
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
