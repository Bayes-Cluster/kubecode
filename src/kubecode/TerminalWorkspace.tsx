import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Plus,
  SplitHorizontal,
  SplitVertical,
  TerminalWindow,
  Trash,
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
import { trackEvent } from '@/lib/telemetry'
import type { TranslationKey } from '@/lib/i18n'

import type { AgentDescriptor, AgentId, KubecodeApi, TerminalInfo, TerminalKind } from './api'
import { TerminalView } from './TerminalView'

type TerminalLayout =
  | { type: 'leaf'; terminalId: string }
  | {
    type: 'split'
    id: string
    direction: 'horizontal' | 'vertical'
    ratio: number
    first: TerminalLayout
    second: TerminalLayout
  }

type TerminalWorkspaceProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  initialTerminals: TerminalInfo[]
  projectId: string
  t: (key: TranslationKey) => string
}

const agentKinds: Array<{ id: AgentId; kind: TerminalKind; label: string }> = [
  { id: 'claude_code', kind: 'claude_code', label: 'Claude Code' },
  { id: 'codex', kind: 'codex', label: 'Codex' },
  { id: 'opencode', kind: 'opencode', label: 'OpenCode' },
]

export function TerminalWorkspace({
  initialTerminals,
  ...props
}: TerminalWorkspaceProps) {
  const initialKey = initialTerminals.map((terminal) => terminal.id).join(':')
  return (
    <TerminalWorkspaceState
      {...props}
      initialTerminals={initialTerminals}
      key={initialKey}
    />
  )
}

function TerminalWorkspaceState({
  agents,
  api,
  initialTerminals,
  projectId,
  t,
}: TerminalWorkspaceProps) {
  const [terminals, setTerminals] = useState(initialTerminals)
  const [{ initialLayout, initialActiveTerminalId }] = useState(() => {
    const initialWorkspace = readTerminalWorkspace(projectId, initialTerminals)
    return {
      initialLayout: initialWorkspace.layout,
      initialActiveTerminalId: initialWorkspace.activeTerminalId,
    }
  })
  const [layout, setLayout] = useState<TerminalLayout | null>(initialLayout)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(initialActiveTerminalId)
  const splitSequence = useRef(0)

  useEffect(() => {
    if (initialTerminals.length === 0 && terminals.length === 0 && hasStoredTerminalWorkspace(projectId)) return
    writeTerminalWorkspace(projectId, { activeTerminalId, layout })
  }, [activeTerminalId, initialTerminals.length, layout, projectId, terminals.length])

  const create = useCallback(async (kind: TerminalKind, split?: 'horizontal' | 'vertical') => {
    const created = await api.createTerminal(projectId, kind, 100, 28)
    setTerminals((current) => [...current, created])
    setLayout((current) => {
      if (!current || !activeTerminalId) return leaf(created.id)
      const replacement = split
        ? {
          type: 'split' as const,
          id: `terminal-split-${++splitSequence.current}`,
          direction: split,
          ratio: 50,
          first: leaf(activeTerminalId),
          second: leaf(created.id),
        }
        : leaf(created.id)
      return replaceLeaf(current, activeTerminalId, replacement)
    })
    setActiveTerminalId(created.id)
    trackEvent('kubecode_terminal_created', { kind, split: split ?? 'none' })
  }, [activeTerminalId, api, projectId])

  const splitActive = (direction: 'horizontal' | 'vertical') => {
    const active = terminals.find((item) => item.id === activeTerminalId)
    void create(active?.kind ?? 'regular', direction)
  }

  const selectTerminal = (terminalId: string) => {
    setLayout((current) => {
      if (!current) return leaf(terminalId)
      if (containsTerminal(current, terminalId)) return current
      return activeTerminalId
        ? replaceLeaf(current, activeTerminalId, leaf(terminalId))
        : leaf(terminalId)
    })
    setActiveTerminalId(terminalId)
  }

  const closeActive = async () => {
    if (!activeTerminalId) return
    await api.closeTerminal(activeTerminalId)
    const remaining = terminals.filter((item) => item.id !== activeTerminalId)
    const nextLayout = removeLeaf(layout, activeTerminalId)
    const nextActive = firstTerminal(nextLayout) ?? remaining[0]?.id ?? null
    setTerminals(remaining)
    setLayout(nextLayout ?? (nextActive ? leaf(nextActive) : null))
    setActiveTerminalId(nextActive)
    trackEvent('kubecode_terminal_closed')
  }

  return (
    <div className="kubecode-terminal-workspace">
      <div className="kubecode-terminal-tabs">
        <TerminalWindow />
        {terminals.map((terminal) => (
          <Button
            key={terminal.id}
            size="xs"
            variant={terminal.id === activeTerminalId ? 'secondary' : 'ghost'}
            onClick={() => selectTerminal(terminal.id)}
          >
            <TerminalKindIcon kind={terminal.kind} />
            {terminal.title}
          </Button>
        ))}
        <TerminalProfileMenu
          agents={agents}
          disabled={!projectId}
          onCreate={(kind) => void create(kind)}
          t={t}
        />
        <Button
          aria-label={t('kubecode.splitRight')}
          disabled={!activeTerminalId}
          size="icon-xs"
          variant="ghost"
          onClick={() => splitActive('horizontal')}
        ><SplitHorizontal /></Button>
        <Button
          aria-label={t('kubecode.splitDown')}
          disabled={!activeTerminalId}
          size="icon-xs"
          variant="ghost"
          onClick={() => splitActive('vertical')}
        ><SplitVertical /></Button>
        <Button
          aria-label={t('kubecode.closeTerminal')}
          disabled={!activeTerminalId}
          size="icon-xs"
          variant="ghost"
          onClick={() => void closeActive()}
        ><Trash /></Button>
      </div>
      {layout ? (
        <TerminalLayoutView
          activeTerminalId={activeTerminalId}
          api={api}
          layout={layout}
          onActivate={setActiveTerminalId}
          onResizeSplit={(splitId, ratio) => setLayout((current) => (
            current ? updateSplitRatio(current, splitId, ratio) : current
          ))}
          projectId={projectId}
          terminals={terminals}
        />
      ) : (
        <div className="kubecode-empty-small">{t('kubecode.newTerminal')}</div>
      )}
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
  t: (key: TranslationKey) => string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t('kubecode.newTerminal')}
          disabled={disabled}
          size="icon-xs"
          variant="ghost"
        ><Plus /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('kubecode.regularTerminal')}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onCreate('regular')}>
          <TerminalWindow /> {t('kubecode.regularTerminal')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('kubecode.agentTui')}</DropdownMenuLabel>
        {agentKinds.map((profile) => {
          const available = agents.some((agent) => agent.id === profile.id && agent.available)
          return (
            <DropdownMenuItem
              disabled={!available}
              key={profile.id}
              onSelect={() => onCreate(profile.kind)}
            >
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
  onResizeSplit,
  projectId,
  terminals,
}: {
  activeTerminalId: string | null
  api: KubecodeApi
  layout: TerminalLayout
  onActivate: (terminalId: string) => void
  onResizeSplit: (splitId: string, ratio: number) => void
  projectId: string
  terminals: TerminalInfo[]
}) {
  if (layout.type === 'leaf') {
    const terminal = terminals.find((item) => item.id === layout.terminalId)
    if (!terminal) return null
    return (
      <div
        className="kubecode-terminal-leaf"
        data-active={layout.terminalId === activeTerminalId}
        onMouseDown={() => onActivate(layout.terminalId)}
      >
        <TerminalView api={api} projectId={projectId} terminal={terminal} />
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
      projectId={projectId}
      terminals={terminals}
    />
  )
}

function TerminalSplit(props: {
  activeTerminalId: string | null
  api: KubecodeApi
  layout: Extract<TerminalLayout, { type: 'split' }>
  onActivate: (terminalId: string) => void
  onResizeSplit: (splitId: string, ratio: number) => void
  projectId: string
  terminals: TerminalInfo[]
}) {
  const { layout, onResizeSplit } = props
  const container = useRef<HTMLDivElement>(null)
  const resize = useCallback((delta: number) => {
    const size = layout.direction === 'horizontal'
      ? container.current?.clientWidth
      : container.current?.clientHeight
    if (!size) return
    onResizeSplit(layout.id, clamp(layout.ratio + delta / size * 100, 5, 95))
  }, [layout.direction, layout.id, layout.ratio, onResizeSplit])

  return (
    <div
      className="kubecode-terminal-split"
      data-split-direction={layout.direction}
      ref={container}
    >
      <div className="kubecode-terminal-split-child" style={{ flexBasis: `${layout.ratio}%` }}>
        <TerminalLayoutView {...props} layout={layout.first} />
      </div>
      <ResizeHandle
        direction={layout.direction === 'horizontal' ? 'horizontal' : 'vertical'}
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

function leaf(terminalId: string): TerminalLayout {
  return { type: 'leaf', terminalId }
}

function containsTerminal(layout: TerminalLayout, terminalId: string): boolean {
  return layout.type === 'leaf'
    ? layout.terminalId === terminalId
    : containsTerminal(layout.first, terminalId) || containsTerminal(layout.second, terminalId)
}

function replaceLeaf(
  layout: TerminalLayout,
  terminalId: string,
  replacement: TerminalLayout,
): TerminalLayout {
  if (layout.type === 'leaf') return layout.terminalId === terminalId ? replacement : layout
  return {
    ...layout,
    first: replaceLeaf(layout.first, terminalId, replacement),
    second: replaceLeaf(layout.second, terminalId, replacement),
  }
}

function removeLeaf(layout: TerminalLayout | null, terminalId: string): TerminalLayout | null {
  if (!layout) return null
  if (layout.type === 'leaf') return layout.terminalId === terminalId ? null : layout
  const first = removeLeaf(layout.first, terminalId)
  const second = removeLeaf(layout.second, terminalId)
  if (!first) return second
  if (!second) return first
  return { ...layout, first, second }
}

function firstTerminal(layout: TerminalLayout | null): string | null {
  if (!layout) return null
  return layout.type === 'leaf' ? layout.terminalId : firstTerminal(layout.first)
}

function updateSplitRatio(layout: TerminalLayout, splitId: string, ratio: number): TerminalLayout {
  if (layout.type === 'leaf') return layout
  if (layout.id === splitId) return { ...layout, ratio }
  return {
    ...layout,
    first: updateSplitRatio(layout.first, splitId, ratio),
    second: updateSplitRatio(layout.second, splitId, ratio),
  }
}

type StoredTerminalWorkspace = {
  activeTerminalId: string | null
  layout: TerminalLayout | null
}

function readTerminalWorkspace(
  projectId: string,
  terminals: TerminalInfo[],
): StoredTerminalWorkspace {
  const fallbackId = terminals[0]?.id ?? null
  const fallback = { activeTerminalId: fallbackId, layout: fallbackId ? leaf(fallbackId) : null }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(terminalStorageKey(projectId)) ?? 'null')
    if (!isRecord(value)) return fallback
    const terminalIds = new Set(terminals.map((terminal) => terminal.id))
    const layout = sanitizeLayout(value.layout, terminalIds)
    if (!layout) return fallback
    const savedActiveId = typeof value.activeTerminalId === 'string' ? value.activeTerminalId : null
    const activeTerminalId = savedActiveId && containsTerminal(layout, savedActiveId)
      ? savedActiveId
      : firstTerminal(layout)
    return { activeTerminalId, layout }
  } catch {
    return fallback
  }
}

function sanitizeLayout(value: unknown, terminalIds: Set<string>): TerminalLayout | null {
  if (!isRecord(value)) return null
  if (value.type === 'leaf') {
    return typeof value.terminalId === 'string' && terminalIds.has(value.terminalId)
      ? leaf(value.terminalId)
      : null
  }
  if (value.type !== 'split') return null
  const first = sanitizeLayout(value.first, terminalIds)
  const second = sanitizeLayout(value.second, terminalIds)
  if (!first) return second
  if (!second) return first
  if (value.direction !== 'horizontal' && value.direction !== 'vertical') return first
  return {
    type: 'split',
    id: typeof value.id === 'string' ? value.id : `terminal-split-restored`,
    direction: value.direction,
    ratio: typeof value.ratio === 'number' && Number.isFinite(value.ratio)
      ? clamp(value.ratio, 5, 95)
      : 50,
    first,
    second,
  }
}

function writeTerminalWorkspace(projectId: string, workspace: StoredTerminalWorkspace): void {
  try {
    localStorage.setItem(terminalStorageKey(projectId), JSON.stringify(workspace))
  } catch {
    // Restricted browser contexts can disable local storage.
  }
}

function hasStoredTerminalWorkspace(projectId: string): boolean {
  try {
    return localStorage.getItem(terminalStorageKey(projectId)) !== null
  } catch {
    return false
  }
}

function terminalStorageKey(projectId: string): string {
  return `kubecode:terminal-layout:${projectId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
