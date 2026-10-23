import { useRef, type ReactNode } from 'react'
import {
  BellDot,
  Circle,
  CircleAlert,
  FolderGit2,
  PanelLeft,
  RotateCw,
  SquareTerminal,
} from 'lucide-react'

import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
  // A decision chosen from the bell opens once the menu has closed: while it is
  // open it holds focus, and on closing it would hand focus back to the bell.
  const chosen = useRef<NeedsYouTarget | null>(null)
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
            <Breadcrumb aria-label={t('kubecode.titlebarLocation')} className="min-w-0">
              <BreadcrumbList className="flex-nowrap">
                {project && !narrowLayout && (
                  <>
                    <BreadcrumbItem className="min-w-0">
                      <span className="truncate">{project.name}</span>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                  </>
                )}
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate">{placeLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          ) : !conversation && (
            <span className="truncate text-sm font-medium">
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
          <TooltipProvider>
            <Tooltip>
            <TooltipTrigger asChild>
              <Badge aria-label={error} role="status" tabIndex={0} variant="destructive">
                <CircleAlert aria-hidden="true" />
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{error}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {attention.total > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t('kubecode.attention.bell', { count: attention.total })}
                size="sm"
                variant="ghost"
              >
                <BellDot aria-hidden data-icon="inline-start" />
                <span aria-hidden="true">{attention.total}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-[min(20rem,calc(100vw-1rem))]"
              onCloseAutoFocus={(event) => {
                const target = chosen.current
                if (!target) return
                chosen.current = null
                event.preventDefault()
                onOpenTarget(target)
              }}
            >
              {attention.current.length > 0 && (
                <>
                  <DropdownMenuLabel>{t('kubecode.attention.thisWorkspace')}</DropdownMenuLabel>
                  {attention.current.slice(0, BELL_ENTRIES).map((entry) => (
                    <DropdownMenuItem
                      key={entry.key}
                      onSelect={() => { chosen.current = entry.target }}
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{entry.title}</span>
                        {entry.detail && (
                          <span className="truncate text-xs text-muted-foreground">{entry.detail}</span>
                        )}
                      </div>
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
        {/* The navigation, then the secondary execution tools: the terminal, and Files and Git. */}
        <ToolToggle glyph={PanelLeft} label={t('kubecode.toggleNavigation')} pressed={sessionSidebarOpen} onClick={toggleNavigation} />
        <Separator className="mx-1 data-[orientation=vertical]:h-4" orientation="vertical" />
        <ToolToggle glyph={SquareTerminal} label={t('kubecode.toggleTerminal')} pressed={terminalOpen} onClick={toggleTerminal} />
        <ToolToggle disabled={!project} glyph={FolderGit2} label={t('kubecode.toggleContext')} pressed={contextOpen} onClick={toggleContext} />
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
          data-state-value={connectionState}
          size="icon-xs"
          variant="ghost"
        >
          <Circle
            aria-hidden="true"
            className={cn(
              connectionState === 'live' && 'text-success-foreground',
              connectionState === 'reconnecting' && 'text-warning-foreground',
              (connectionState === 'connecting' || connectionState === 'resynchronizing')
                && 'text-muted-foreground motion-safe:animate-pulse',
            )}
            fill="currentColor"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-1rem))]">
        <DropdownMenuLabel>{t('kubecode.runtimeConnection')}</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between gap-4 font-normal" role="status">
            <span className="text-muted-foreground">{t('kubecode.connectionStatus')}</span>
            <Badge variant={CONNECTION_BADGE[connectionState]}>{stateLabel}</Badge>
          </DropdownMenuLabel>
          <DropdownMenuLabel className="flex items-center justify-between gap-4 font-normal">
            <span className="text-muted-foreground">{t('kubecode.lastSuccessfulSync')}</span>
            <time dateTime={lastSuccessfulSyncAt === null
              ? undefined : new Date(lastSuccessfulSyncAt).toISOString()}>{lastSync}</time>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {connectionState === 'reconnecting' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRetry}>
              <RotateCw aria-hidden="true" />
              {t('kubecode.retry')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const CONNECTION_BADGE: Record<WorkspaceConnectionState, 'success' | 'warning' | 'secondary'> = {
  connecting: 'secondary',
  live: 'success',
  reconnecting: 'warning',
  resynchronizing: 'secondary',
}

/** A title-bar toggle for the navigation or an execution tool: one glyph, pressed while it is open. */
function ToolToggle({ disabled, glyph: Glyph, label, onClick, pressed }: {
  disabled?: boolean
  glyph: typeof PanelLeft
  label: string
  pressed: boolean
  onClick: () => void
}) {
  return (
    <Toggle
      aria-label={label}
      disabled={disabled}
      onPressedChange={onClick}
      pressed={pressed}
      size="sm"
      title={label}
    >
      <Glyph aria-hidden="true" />
    </Toggle>
  )
}
