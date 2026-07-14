import { useCallback, useRef, useState } from 'react'
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
  const [layout, setLayout] = useState<TerminalLayout | null>(() => (
    initialTerminals[0] ? leaf(initialTerminals[0].id) : null
  ))
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(
    initialTerminals[0]?.id ?? null,
  )
  const splitSequence = useRef(0)

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
  projectId,
  terminals,
}: {
  activeTerminalId: string | null
  api: KubecodeApi
  layout: TerminalLayout
  onActivate: (terminalId: string) => void
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
  projectId: string
  terminals: TerminalInfo[]
}) {
  const { layout } = props
  const container = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(50)
  const resize = useCallback((delta: number) => {
    const size = layout.direction === 'horizontal'
      ? container.current?.clientWidth
      : container.current?.clientHeight
    if (!size) return
    setRatio((current) => clamp(current + delta / size * 100, 5, 95))
  }, [layout.direction])

  return (
    <div
      className="kubecode-terminal-split"
      data-split-direction={layout.direction}
      ref={container}
    >
      <div className="kubecode-terminal-split-child" style={{ flexBasis: `${ratio}%` }}>
        <TerminalLayoutView {...props} layout={layout.first} />
      </div>
      <ResizeHandle
        direction={layout.direction === 'horizontal' ? 'horizontal' : 'vertical'}
        onResize={resize}
      />
      <div className="kubecode-terminal-split-child" style={{ flexBasis: `${100 - ratio}%` }}>
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
