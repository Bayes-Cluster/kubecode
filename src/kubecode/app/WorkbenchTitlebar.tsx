import { type RefObject } from 'react'
import {
  ArrowClockwise,
  Bell,
  Circle,
  MagnifyingGlass,
  WarningCircle,
} from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
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

import type { Conversation, Project } from '../api'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { togglePanel } from './panelToggles'
import type { Translator } from './translator'

export type WorkbenchTitlebarProps = {
  attentionSessions: Conversation[]
  connectionState: WorkspaceConnectionState
  contextOpen: boolean
  conversation: Conversation | null
  error: string | null
  lastSuccessfulSyncAt: number | null
  locale: string
  narrowLayout: boolean
  navigatorQuery: string
  navigatorSearchRef: RefObject<HTMLInputElement | null>
  onContextOpenChange: (open: boolean) => void
  onNavigatorQueryChange: (query: string) => void
  onOpenSession: (projectId: string, conversationId: string) => void
  onRetryConnection: () => void
  onSessionSidebarOpenChange: (open: boolean) => void
  onTerminalOpenChange: (open: boolean | ((open: boolean) => boolean)) => void
  project: Project | null
  projects: Project[]
  sessionSidebarOpen: boolean
  t: Translator
  terminalOpen: boolean
  titlebarTargetRef: (node: HTMLDivElement | null) => void
}

export function WorkbenchTitlebar({
  attentionSessions,
  connectionState,
  contextOpen,
  conversation,
  error,
  lastSuccessfulSyncAt,
  locale,
  narrowLayout,
  navigatorQuery,
  navigatorSearchRef,
  onContextOpenChange,
  onNavigatorQueryChange,
  onOpenSession,
  onRetryConnection,
  onSessionSidebarOpenChange,
  onTerminalOpenChange,
  project,
  projects,
  sessionSidebarOpen,
  t,
  terminalOpen,
  titlebarTargetRef,
}: WorkbenchTitlebarProps) {
  const toggleSessions = () => {
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
          {!conversation && (
            <span className="kubecode-titlebar-project">
              {project?.name ?? t('kubecode.appName')}
            </span>
          )}
        </div>
      </div>
      <div className="kubecode-search">
        <MagnifyingGlass />
        <Input
          aria-label={t('kubecode.searchSessions')}
          placeholder={t('kubecode.searchSessions')}
          ref={navigatorSearchRef}
          spellCheck={false}
          value={navigatorQuery}
          onChange={(event) => onNavigatorQueryChange(event.target.value)}
        />
        <kbd>⌘K</kbd>
      </div>
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
            <WarningCircle weight="fill" />
          </span>
        )}
        {attentionSessions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t('kubecode.sessionsRequireInput', { count: attentionSessions.length })}
                className="kubecode-attention-trigger"
                size="sm"
                variant="ghost"
              >
                <Bell weight="fill" />
                <span>{attentionSessions.length}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="kubecode-attention-menu">
              {attentionSessions.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onSelect={() => onOpenSession(item.project_id, item.id)}
                >
                  <AiAgentIcon agent={item.agent_id} size={18} />
                  <span>
                    <strong>{item.title || t('kubecode.untitledSession')}</strong>
                    <small>{projects.find((projectItem) => projectItem.id === item.project_id)?.name}</small>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button aria-label={t('kubecode.toggleSessions')} aria-pressed={sessionSidebarOpen} className="kubecode-layout-toggle" size="icon-xs" variant="ghost" onClick={toggleSessions}>
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
          <Circle aria-hidden="true" weight="fill" />
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
              <ArrowClockwise />
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


