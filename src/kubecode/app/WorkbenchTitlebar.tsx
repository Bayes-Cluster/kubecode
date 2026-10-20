import { useRef, type ReactNode } from 'react'
import {
  BellDot,
  Circle,
  CircleAlert,
  RotateCw,
} from 'lucide-react'

import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import type { Conversation, Project } from '../api'
import type { NeedsYouEntry, NeedsYouTarget } from './location/needsYou'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { togglePanel } from './panelToggles'
import type { Translator } from '@/lib/i18n'

/** What waits on the researcher: this Workspace's decisions, and counts for the others (ADR 0232). */
export type TitlebarAttention = {
  current: NeedsYouEntry[]
  others: Array<{ projectId: string; name: string; count: number }>
  total: number
}

const BELL_ENTRIES = 5

export type WorkbenchTitlebarProps = {
  attention: TitlebarAttention
  connectionState: WorkspaceConnectionState
  contextOpen: boolean
  conversation: Conversation | null
  error: string | null
  lastSuccessfulSyncAt: number | null
  locale: string
  narrowLayout: boolean
  onContextOpenChange: (open: boolean) => void
  /** Opens a decision of this Workspace where it is made. */
  onOpenTarget: (target: NeedsYouTarget) => void
  /** Enters another Workspace with its Needs you in view. */
  onOpenWorkspaceNeeds: (projectId: string) => void
  onRetryConnection: () => void
  onSessionSidebarOpenChange: (open: boolean) => void
  onTerminalOpenChange: (open: boolean | ((open: boolean) => boolean)) => void
  /**
   * The place on screen, shown as "Workspace / place". Absent on the Sessions
   * surface, which titles itself through `titlebarTargetRef`.
   */
  placeLabel: string | null
  project: Project | null
  /** The centre of the title bar, for a search that names its own scope. */
  searchSlot?: ReactNode
  sessionSidebarOpen: boolean
  t: Translator
  terminalOpen: boolean
  titlebarTargetRef: (node: HTMLDivElement | null) => void
}

export function WorkbenchTitlebar({
  attention,
  connectionState,
  contextOpen,
  conversation,
  error,
  lastSuccessfulSyncAt,
  locale,
  narrowLayout,
  onContextOpenChange,
  onOpenTarget,
  onOpenWorkspaceNeeds,
  onRetryConnection,
  onSessionSidebarOpenChange,
  onTerminalOpenChange,
  placeLabel,
  project,
  searchSlot,
  sessionSidebarOpen,
  t,
  terminalOpen,
  titlebarTargetRef,
}: WorkbenchTitlebarProps) {
  // Set when a decision is chosen from the bell, so closing it leaves focus there.
  const openedEntry = useRef(false)
  const toggleNavigation = () => {
    const nextOpen = togglePanel('sessions', sessionSidebarOpen)
    onSessionSidebarOpenChange(nextOpen)
    if (narrowLayout && nextOpen) onContextOpenChange(false)
  }

  const toggleTerminal = () => onTerminalOpenChange((open) => togglePanel('terminal', open))

  const toggleContext = () => {
    const nextOpen = togglePanel('context', contextOpen)
    onContextOpenChange(nextOpen)
    if (narrowLayout && nextOpen) onSessionSidebarOpenChange(false)
  }

  return (
    <header className="kubecode-topbar">
      <div className="kubecode-topbar-leading">
        <div className="kubecode-titlebar-session-slot" ref={titlebarTargetRef}>
          {placeLabel !== null ? (
            <span className="kubecode-titlebar-project kubecode-titlebar-place">
              {project && !narrowLayout && (
                <>
                  <span className="kubecode-titlebar-workspace">{project.name}</span>
                  <span aria-hidden="true" className="kubecode-titlebar-separator">/</span>
                </>
              )}
              <span>{placeLabel}</span>
            </span>
          ) : !conversation && (
            <span className="kubecode-titlebar-project">
              {project?.name ?? t('kubecode.appName')}
            </span>
          )}
        </div>
      </div>
      <div className="kubecode-titlebar-search-slot">{searchSlot}</div>
      <div className="kubecode-topbar-actions">
        <RuntimeConnectionMenu
          connectionState={connectionState}
          lastSuccessfulSyncAt={lastSuccessfulSyncAt}
          locale={locale}
          onRetry={onRetryConnection}
          t={t}
        />
        {error && (
          <span
            aria-label={error}
            className="kubecode-topbar-error"
            role="status"
            title={error}
          >
            <CircleAlert fill="currentColor"  size={16}/>
          </span>
        )}
        {attention.total > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t('kubecode.attention.bell', { count: attention.total })}
                className="kubecode-attention-trigger"
                size="sm"
                variant="ghost"
              >
                <BellDot aria-hidden size={16} />
                <span aria-hidden="true">{attention.total}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="kubecode-attention-menu"
              // A chosen decision takes focus where it opens; the bell must not take it back.
              onCloseAutoFocus={(event) => {
                if (!openedEntry.current) return
                openedEntry.current = false
                event.preventDefault()
              }}
            >
              {attention.current.length > 0 && (
                <>
                  <DropdownMenuLabel>{t('kubecode.attention.thisWorkspace')}</DropdownMenuLabel>
                  {attention.current.slice(0, BELL_ENTRIES).map((entry) => (
                    <DropdownMenuItem
                      key={entry.key}
                      onSelect={() => {
                        openedEntry.current = true
                        onOpenTarget(entry.target)
                      }}
                    >
                      <span className="kubecode-attention-menu-entry">
                        <strong>{entry.title}</strong>
                        {entry.detail && <small>{entry.detail}</small>}
                      </span>
                      <StatusBadge tone={entry.reason.tone}>{entry.reason.label}</StatusBadge>
                    </DropdownMenuItem>
                  ))}
                  {attention.current.length > BELL_ENTRIES && project && (
                    <DropdownMenuItem onSelect={() => onOpenWorkspaceNeeds(project.id)}>
                      {t('kubecode.attention.showAll', { count: attention.current.length })}
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {attention.current.length > 0 && attention.others.length > 0 && <DropdownMenuSeparator />}
              {attention.others.length > 0 && (
                <>
                  <DropdownMenuLabel>{t('kubecode.attention.otherWorkspaces')}</DropdownMenuLabel>
                  {attention.others.map((other) => (
                    <DropdownMenuItem key={other.projectId} onSelect={() => onOpenWorkspaceNeeds(other.projectId)}>
                      {t('kubecode.attention.otherWorkspace', { workspace: other.name, count: other.count })}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button aria-label={t('kubecode.toggleNavigation')} aria-pressed={sessionSidebarOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={toggleNavigation}>
          <PanelToggleIcon active={sessionSidebarOpen} panel="left" />
        </Button>
        <Button aria-label={t('kubecode.toggleTerminal')} aria-pressed={terminalOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={toggleTerminal}>
          <PanelToggleIcon active={terminalOpen} panel="bottom" />
        </Button>
        <Button aria-label={t('kubecode.toggleContext')} aria-pressed={contextOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={toggleContext}>
          <PanelToggleIcon active={contextOpen} panel="right" />
        </Button>
      </div>
    </header>
  )
}

function RuntimeConnectionMenu({
  connectionState,
  lastSuccessfulSyncAt,
  locale,
  onRetry,
  t,
}: {
  connectionState: WorkspaceConnectionState
  lastSuccessfulSyncAt: number | null
  locale: string
  onRetry: () => void
  t: Translator
}) {
  const stateLabel = t(`kubecode.connectionState.${connectionState}`)
  const lastSync = lastSuccessfulSyncAt === null
    ? t('kubecode.never')
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
      .format(lastSuccessfulSyncAt)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t('kubecode.runtimeConnectionState', { state: stateLabel })}
          className="kubecode-connection-trigger"
          data-state-value={connectionState}
          size="icon-xs"
          variant="ghost"
        >
          <Circle aria-hidden="true" fill="currentColor"  size={16}/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="kubecode-connection-menu">
        <DropdownMenuLabel>{t('kubecode.runtimeConnection')}</DropdownMenuLabel>
        <div className="kubecode-connection-row" role="status">
          <span>{t('kubecode.connectionStatus')}</span>
          <strong>{stateLabel}</strong>
        </div>
        <div className="kubecode-connection-row">
          <span>{t('kubecode.lastSuccessfulSync')}</span>
          <time dateTime={lastSuccessfulSyncAt === null
            ? undefined : new Date(lastSuccessfulSyncAt).toISOString()}>{lastSync}</time>
        </div>
        {connectionState === 'reconnecting' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRetry}>
              <RotateCw  size={16}/>
              {t('kubecode.retry')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PanelToggleIcon({
  active,
  panel,
}: {
  active: boolean
  panel: 'left' | 'bottom' | 'right'
}) {
  return (
    <span className="kubecode-panel-toggle-icon" data-active={active} data-panel={panel}>
      <span />
    </span>
  )
}

