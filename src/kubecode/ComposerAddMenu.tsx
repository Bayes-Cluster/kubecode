import {
  ChevronLeft,
  CircleAlert,
  File,
  FlaskConical,
  GitCompare,
  MessageSquareMore,
  Plus,
  Sparkle,
  SquareTerminal
} from 'lucide-react'
import { useMemo, useRef, useState, type ComponentProps } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type {
  ComposerCatalogSnapshot, Entry, GitDiffContextCandidate, KubecodeApi, ProjectContextItem,
} from './api'
import { CapabilityRowContent, type ComposerCapabilityPickerLabels } from './ComposerCapabilityPicker'
import { rankComposerCapabilities, type RankedComposerCapability } from './composerCapabilities'
import { ComposerProjectWorkPicker } from './ComposerProjectWorkPicker'
import { ProjectFilePicker } from './ProjectFilePicker'
import { ReaderEmpty, ReaderLoading, ReaderNotice } from './resources/ReaderStates'
import type { TerminalContextSource } from './TerminalWorkspace'
import { MaterialFileIcon } from './icons/material/materialIcons'
import { resolveFileIcon } from './icons/resolveFileIcon'

export type ComposerAgentCommand = { name: string; description: string }
export type TerminalContextRequest = {
  terminalId: string
  capture: 'selection' | 'recent'
  selectedText?: string
}
export type SessionTurnContextSource = {
  turnId: string
  userPreview: string | null
  agentPreview: string | null
}
export type SessionTurnContextRequest = {
  turnId: string
  role: 'user' | 'agent'
}

type ComposerAddMenuProps = {
  api: KubecodeApi
  capabilityCatalog?: ComposerCatalogSnapshot
  capabilityEmptyLabel?: string
  capabilityLabels?: ComposerCapabilityPickerLabels
  capabilityStatus?: 'error' | 'loading' | 'ready'
  commands: ComposerAgentCommand[]
  conversationId: string
  gitDiffLabels?: {
    all: string
    disabled: (reason: string | null) => string
    summary: (candidate: GitDiffContextCandidate) => string
  }
  onInsert: (text: string, kind: 'command') => void
  onCapability?: (capability: RankedComposerCapability) => void
  onGitDiff?: (candidate: GitDiffContextCandidate) => void
  onProjectContext?: (item: ProjectContextItem) => void
  onReference: (entry: Entry) => void
  onSessionTurnContext?: (request: SessionTurnContextRequest) => void
  onTerminalContext?: (request: TerminalContextRequest) => void
  projectId: string
  t: Translator
  sessionTurnSources?: SessionTurnContextSource[]
  terminalSources?: TerminalContextSource[]
}

/** One choice in the add menu: an official Item rendered as a button. */
function MenuRow({ className, ...props }: ComponentProps<'button'>) {
  return (
    <Item asChild className={cn('text-left pointer-coarse:min-h-11', className)} size="sm">
      <button type="button" {...props} />
    </Item>
  )
}

export function ComposerAddMenu({
  api,
  capabilityCatalog,
  capabilityEmptyLabel,
  capabilityLabels,
  capabilityStatus = 'loading',
  commands,
  conversationId,
  gitDiffLabels,
  onInsert,
  onCapability,
  onGitDiff,
  onProjectContext,
  onReference,
  onSessionTurnContext,
  onTerminalContext,
  projectId,
  t,
  sessionTurnSources = [],
  terminalSources = [],
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [showGitDiffs, setShowGitDiffs] = useState(false)
  const [showSessionTurns, setShowSessionTurns] = useState(false)
  const [showProjectWork, setShowProjectWork] = useState(false)
  const [showTerminals, setShowTerminals] = useState(false)
  const [gitDiffState, setGitDiffState] = useState<{
    candidates: GitDiffContextCandidate[]
    status: 'error' | 'loading' | 'ready'
  }>({ candidates: [], status: 'loading' })
  const [query, setQuery] = useState('')
  // cmdk's highlighted row, kept so Tab can accept it the way Enter does.
  const [activeCapability, setActiveCapability] = useState('')
  const [paletteLayout, setPaletteLayout] = useState({ alignOffset: 0, width: 680 })
  const rootRef = useRef<HTMLDivElement>(null)
  const visibleCommands = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    if (!search) return commands
    return commands.filter((command) => (
      command.name.toLocaleLowerCase().includes(search)
        || command.description.toLocaleLowerCase().includes(search)
    ))
  }, [commands, query])
  const visibleCapabilities = useMemo(
    () => rankComposerCapabilities(capabilityCatalog, query),
    [capabilityCatalog, query],
  )
  const hasCapabilities = useMemo(
    () => rankComposerCapabilities(capabilityCatalog, '').length > 0,
    [capabilityCatalog],
  )
  const capabilityPickerVisible = Boolean(
    capabilityLabels && (hasCapabilities || capabilityStatus !== 'ready'),
  )

  const close = () => {
    setOpen(false)
    setQuery('')
    setActiveCapability('')
    setShowFiles(false)
    setShowGitDiffs(false)
    setShowSessionTurns(false)
    setShowProjectWork(false)
    setShowTerminals(false)
  }

  const chooseCapability = (capability: RankedComposerCapability | undefined) => {
    if (!capability?.enabled || !onCapability) return
    onCapability(capability)
    close()
  }

  const closeAndInsert = (text: string) => {
    onInsert(text, 'command')
    close()
  }

  const resetPanels = () => {
    setShowFiles(false)
    setShowGitDiffs(false)
    setShowSessionTurns(false)
    setShowProjectWork(false)
    setShowTerminals(false)
  }

  const inPanel = showFiles || showGitDiffs || showSessionTurns || showProjectWork || showTerminals

  return (
    <div className="relative" ref={rootRef}>
      {/* The official Popover owns dismissal (outside press, Escape), focus return, and stacking. */}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true)
          else close()
        }}
      >
      <PopoverTrigger asChild>
      <Button
        aria-expanded={open}
        aria-label={t('kubecode.addContext')}
        className="h-8 w-8 shrink-0 rounded-full p-0"
        size="icon-sm"
        title={t('kubecode.addContext')}
        type="button"
        variant="ghost"
        onClick={() => {
          // Opened above the composer, as wide as it, starting at its left edge.
          const composer = rootRef.current?.closest('[data-testid="agent-composer-surface"]')
          const composerRect = composer?.getBoundingClientRect()
          const triggerRect = rootRef.current?.getBoundingClientRect()
          if (composerRect) {
            setPaletteLayout({
              alignOffset: composerRect.left - (triggerRect?.left ?? composerRect.left),
              width: composerRect.width,
            })
          }
          resetPanels()
        }}
      >
        <Plus size={19} />
      </Button>
      </PopoverTrigger>
        <PopoverContent
          align="start"
          alignOffset={paletteLayout.alignOffset}
          aria-label={t('kubecode.addContext')}
          className="flex max-h-[min(520px,58vh)] max-w-[calc(100vw-16px)] flex-col overflow-hidden p-0"
          onEscapeKeyDown={(event) => {
            // Radix sees Escape in the capture phase, before inner layers. Inside a
            // panel, keep the popover open and let the layers peel one at a time.
            if (inPanel || event.isComposing) event.preventDefault()
          }}
          onKeyDown={(event) => {
            // Reached only when no inner layer (preview, typed query) consumed Escape.
            if (event.key !== 'Escape' || !inPanel || event.nativeEvent.isComposing) return
            event.preventDefault()
            resetPanels()
          }}
          side="top"
          sideOffset={12}
          style={{ width: paletteLayout.width }}
        >
          {showFiles ? (
            <>
              <div className="flex items-center border-b border-border px-2 py-1.5">
                <Button
                  className="min-w-0 justify-start gap-2"
                  onClick={() => setShowFiles(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft  size={16}/>
                  <span className="truncate">{t('kubecode.referenceFile')}</span>
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <ProjectFilePicker
                  api={api}
                  conversationId={conversationId}
                  includeDirectories
                  onEscape={() => setShowFiles(false)}
                  onOpenFile={(entry) => {
                    onReference(entry)
                    close()
                  }}
                  projectId={projectId}
                  refreshVersion={0}
                  t={t}
                />
              </div>
            </>
          ) : showGitDiffs && gitDiffLabels && onGitDiff ? (
            <>
              <div className="flex items-center border-b border-border px-2 py-1.5">
                <Button
                  className="min-w-0 justify-start gap-2"
                  onClick={() => setShowGitDiffs(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft  size={16}/>
                  <span className="truncate">{t('kubecode.referenceGitDiff')}</span>
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {gitDiffState.status === 'loading' ? (
                  <ReaderLoading>{t('kubecode.loadingContext')}</ReaderLoading>
                ) : gitDiffState.status === 'error' ? (
                  <ReaderNotice failed>{t('kubecode.contextLoadFailed')}</ReaderNotice>
                ) : gitDiffState.candidates.length === 0 ? (
                  <ReaderEmpty>{t('kubecode.gitDiffEmpty')}</ReaderEmpty>
                ) : gitDiffState.candidates.map((candidate) => (
                  <MenuRow
                    className="w-full"
                    disabled={!candidate.enabled}
                    key={candidate.path ?? 'all'}
                    onClick={() => {
                      if (!candidate.enabled) return
                      onGitDiff(candidate)
                      close()
                    }}
                  >
                    <ItemMedia variant="icon">{candidate.path
                      ? <MaterialFileIcon className="shrink-0" id={resolveFileIcon(candidate.path)} size={20} />
                      : <GitCompare />}</ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>
                        {candidate.path?.split('/').at(-1) ?? gitDiffLabels.all}
                      </ItemTitle>
                      <ItemDescription>
                        {candidate.enabled
                          ? gitDiffLabels.summary(candidate)
                          : gitDiffLabels.disabled(candidate.disabled_reason)}
                      </ItemDescription>
                    </ItemContent>
                  </MenuRow>
                ))}
              </div>
            </>
          ) : showProjectWork && onProjectContext ? (
            <>
              <div className="flex items-center border-b border-border px-2 py-1.5">
                <Button
                  className="min-w-0 justify-start gap-2"
                  onClick={() => setShowProjectWork(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft size={16} />
                  <span className="truncate">{t('kubecode.referenceProjectWork')}</span>
                </Button>
              </div>
              <ComposerProjectWorkPicker
                api={api}
                conversationId={conversationId}
                onSelect={(item) => {
                  onProjectContext(item)
                  close()
                }}
                projectId={projectId}
                t={t}
              />
            </>
          ) : showSessionTurns && onSessionTurnContext ? (
            <>
              <div className="flex items-center border-b border-border px-2 py-1.5">
                <Button
                  className="min-w-0 justify-start gap-2"
                  onClick={() => setShowSessionTurns(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft  size={16}/>
                  <span className="truncate">{t('kubecode.referenceSessionTurns')}</span>
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <section aria-label={t('kubecode.userTurns')} role="group">
                  <h3 className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    {t('kubecode.userTurns')}
                  </h3>
                  {[...sessionTurnSources].reverse().map((source) => source.userPreview && (
                    <MenuRow
                      aria-label={t('kubecode.attachPriorUserTurn', { preview: source.userPreview })}
                      className="w-full"
                      key={`user:${source.turnId}`}
                      onClick={() => {
                        onSessionTurnContext({ role: 'user', turnId: source.turnId })
                        close()
                      }}
                    >
                      <ItemMedia variant="icon"><MessageSquareMore /></ItemMedia>
                      <ItemContent className="min-w-0">
                        <ItemTitle>{t('kubecode.priorUserTurn')}</ItemTitle>
                        <ItemDescription className="truncate">
                          {source.userPreview}
                        </ItemDescription>
                      </ItemContent>
                    </MenuRow>
                  ))}
                </section>
                <section aria-label={t('kubecode.agentResponses')} role="group">
                  <h3 className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                    {t('kubecode.agentResponses')}
                  </h3>
                  {[...sessionTurnSources].reverse().map((source) => source.agentPreview && (
                    <MenuRow
                      aria-label={t('kubecode.attachPriorAgentResponse', {
                        preview: source.agentPreview,
                      })}
                      className="w-full"
                      key={`agent:${source.turnId}`}
                      onClick={() => {
                        onSessionTurnContext({ role: 'agent', turnId: source.turnId })
                        close()
                      }}
                    >
                      <ItemMedia variant="icon"><MessageSquareMore /></ItemMedia>
                      <ItemContent className="min-w-0">
                        <ItemTitle>{t('kubecode.priorAgentResponse')}</ItemTitle>
                        <ItemDescription className="truncate">
                          {source.agentPreview}
                        </ItemDescription>
                      </ItemContent>
                    </MenuRow>
                  ))}
                </section>
              </div>
            </>
          ) : showTerminals && onTerminalContext ? (
            <>
              <div className="flex items-center border-b border-border px-2 py-1.5">
                <Button
                  className="min-w-0 justify-start gap-2"
                  onClick={() => setShowTerminals(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft  size={16}/>
                  <span className="truncate">{t('kubecode.referenceTerminalOutput')}</span>
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {terminalSources.map((source) => {
                  const pane = t('kubecode.terminalPane', { index: source.paneIndex })
                  return (
                    <div className="border-b border-border py-1 last:border-b-0" key={source.terminalId}>
                      <div className="flex min-w-0 items-center gap-2 px-3 py-1 text-sm font-medium">
                        <SquareTerminal className="shrink-0" size={18} />
                        <span className="truncate">{pane}</span>
                      </div>
                      <MenuRow
                        aria-label={t('kubecode.attachSelectedTerminalOutput', { pane })}
                        className="w-full pl-8"
                        disabled={!source.selectedText}
                        onClick={() => {
                          if (!source.selectedText) return
                          onTerminalContext({
                            capture: 'selection',
                            selectedText: source.selectedText,
                            terminalId: source.terminalId,
                          })
                          close()
                        }}
                      >
                        <ItemContent className="min-w-0">
                          <ItemTitle>{t('kubecode.terminalSelectedOutput')}</ItemTitle>
                          <ItemDescription>
                            {source.selectedText
                              ? t('kubecode.terminalSelectionReady')
                              : t('kubecode.terminalSelectionUnavailable')}
                          </ItemDescription>
                        </ItemContent>
                      </MenuRow>
                      <MenuRow
                        aria-label={t('kubecode.attachRecentTerminalOutput', { pane })}
                        className="w-full pl-8"
                        onClick={() => {
                          onTerminalContext({ capture: 'recent', terminalId: source.terminalId })
                          close()
                        }}
                      >
                        <ItemContent className="min-w-0">
                          <ItemTitle>{t('kubecode.terminalRecentOutput')}</ItemTitle>
                          <ItemDescription>
                            {t('kubecode.terminalRecentOutputDescription')}
                          </ItemDescription>
                        </ItemContent>
                      </MenuRow>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            // The official Command owns the capability combobox: focus, arrows,
            // wrap-around, skipping disabled rows, and aria-activedescendant.
            <Command
              className="min-h-0 flex-1 rounded-none bg-transparent"
              label={t('kubecode.searchContext')}
              loop
              onValueChange={setActiveCapability}
              shouldFilter={false}
              value={activeCapability}
            >
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <MenuRow
                  className="w-full"
                  onClick={() => setShowFiles(true)}
                >
                  <ItemMedia variant="icon"><File /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{t('kubecode.referenceFile')}</ItemTitle>
                    <ItemDescription className="truncate">
                      {t('kubecode.chooseFileReference')}
                    </ItemDescription>
                  </ItemContent>
                </MenuRow>
                {gitDiffLabels && onGitDiff && <MenuRow
                  className="w-full"
                  onClick={() => {
                    setShowGitDiffs(true)
                    setGitDiffState({ candidates: [], status: 'loading' })
                    void api.listComposerGitDiffs(conversationId).then((result) => {
                      setGitDiffState({ candidates: result.candidates, status: 'ready' })
                    }).catch(() => setGitDiffState({ candidates: [], status: 'error' }))
                  }}
                                  >
                  <ItemMedia variant="icon"><GitCompare /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{t('kubecode.referenceGitDiff')}</ItemTitle>
                    <ItemDescription>
                      {t('kubecode.chooseGitDiffReference')}
                    </ItemDescription>
                  </ItemContent>
                </MenuRow>}
                {terminalSources.length > 0 && onTerminalContext && <MenuRow
                  className="w-full"
                  onClick={() => setShowTerminals(true)}
                >
                  <ItemMedia variant="icon"><SquareTerminal /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>
                      {t('kubecode.referenceTerminalOutput')}
                    </ItemTitle>
                    <ItemDescription>
                      {t('kubecode.chooseTerminalOutputReference')}
                    </ItemDescription>
                  </ItemContent>
                </MenuRow>}
                {onProjectContext && <MenuRow
                  className="w-full"
                  onClick={() => setShowProjectWork(true)}
                >
                  <ItemMedia variant="icon"><FlaskConical /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>
                      {t('kubecode.referenceProjectWork')}
                    </ItemTitle>
                    <ItemDescription>
                      {t('kubecode.chooseProjectWorkReference')}
                    </ItemDescription>
                  </ItemContent>
                </MenuRow>}
                {sessionTurnSources.length > 0 && onSessionTurnContext && <MenuRow
                  className="w-full"
                  onClick={() => setShowSessionTurns(true)}
                >
                  <ItemMedia variant="icon"><MessageSquareMore /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>
                      {t('kubecode.referenceSessionTurns')}
                    </ItemTitle>
                    <ItemDescription>
                      {t('kubecode.chooseSessionTurnReference')}
                    </ItemDescription>
                  </ItemContent>
                </MenuRow>}
                <MenuRow
                  className="w-full"
                  disabled
                >
                  <ItemMedia variant="icon"><CircleAlert /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>
                      {t('kubecode.diagnosticsUnavailable')}
                    </ItemTitle>
                    <ItemDescription>
                      {t('kubecode.diagnosticsUnavailableDescription')}
                    </ItemDescription>
                  </ItemContent>
                </MenuRow>
                {visibleCommands.map((command) => (
                  <MenuRow
                    className="w-full"
                    key={command.name}
                    onClick={() => closeAndInsert(`/${command.name} `)}
                  >
                    <ItemMedia variant="icon"><Sparkle /></ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>/{command.name}</ItemTitle>
                      {command.description && (
                        <ItemDescription className="truncate">
                          {command.description}
                        </ItemDescription>
                      )}
                    </ItemContent>
                  </MenuRow>
                ))}
                {capabilityLabels && capabilityPickerVisible && (
                  <div
                    aria-busy={capabilityStatus === 'loading'}
                    aria-live="polite"
                    className="mt-1 border-t border-border pt-1"
                  >
                    {capabilityStatus === 'loading' ? (
                      <p className="px-3 py-3 text-sm text-muted-foreground">{capabilityLabels.loading}</p>
                    ) : capabilityStatus === 'error' ? (
                      <p className="px-3 py-3 text-sm text-destructive">{capabilityLabels.error}</p>
                    ) : visibleCapabilities.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-muted-foreground">{capabilityLabels.empty}</p>
                    ) : null}
                    <CommandList aria-label={capabilityLabels.picker} className="max-h-none overflow-visible">
                      <CommandGroup className="p-0">
                        {visibleCapabilities.map((item, index) => (
                          <CommandItem
                            aria-describedby={item.enabled ? undefined : `${item.id}-reason-${index}`}
                            className="min-h-12 items-start pointer-coarse:min-h-11"
                            disabled={!item.enabled}
                            key={item.id}
                            onSelect={() => chooseCapability(item)}
                            value={item.id}
                          >
                            <CapabilityRowContent
                              item={item}
                              labels={capabilityLabels}
                              reasonId={`${item.id}-reason-${index}`}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </div>
                )}
                {commands.length === 0 && !hasCapabilities && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {t('kubecode.noAgentSkillsCommands')}
                  </p>
                )}
                {capabilityEmptyLabel && (
                  <p
                    className="border-t border-border px-3 py-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    {capabilityEmptyLabel}
                  </p>
                )}
              </div>
              <div className="border-t border-border p-2">
                <CommandInput
                  aria-label={t('kubecode.searchContext')}
                  autoFocus
                  onKeyDown={(event) => {
                    // Tab accepts the active capability, as Enter does.
                    if (event.key !== 'Tab' || event.shiftKey || event.nativeEvent.isComposing) return
                    const capability = visibleCapabilities.find((item) => item.id === activeCapability)
                    if (!capability?.enabled || !onCapability) return
                    event.preventDefault()
                    chooseCapability(capability)
                  }}
                  onValueChange={setQuery}
                  placeholder={t('kubecode.searchContext')}
                  value={query}
                />
              </div>
            </Command>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
