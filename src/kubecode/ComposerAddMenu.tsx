import { CaretLeft, File, GitDiff, Plus, Sparkle } from '@phosphor-icons/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TranslationKey } from '@/lib/i18n'

import type {
  ComposerCatalogSnapshot, Entry, GitDiffContextCandidate, KubecodeApi,
} from './api'
import { ComposerCapabilityPicker, type ComposerCapabilityPickerLabels } from './ComposerCapabilityPicker'
import { rankComposerCapabilities, type RankedComposerCapability } from './composerCapabilities'
import { ProjectFilePicker } from './ProjectFilePicker'

export type ComposerAgentCommand = { name: string; description: string }

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
  onReference: (entry: Entry) => void
  projectId: string
  t: (key: TranslationKey) => string
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
  onReference,
  projectId,
  t,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [showGitDiffs, setShowGitDiffs] = useState(false)
  const [gitDiffState, setGitDiffState] = useState<{
    candidates: GitDiffContextCandidate[]
    status: 'error' | 'loading' | 'ready'
  }>({ candidates: [], status: 'loading' })
  const [query, setQuery] = useState('')
  const [paletteLayout, setPaletteLayout] = useState({ bottom: 0, left: 0, width: 680 })
  const [selectedCapabilityIndex, setSelectedCapabilityIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const capabilityListboxId = useId()
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
  const enabledCapabilityIndexes = visibleCapabilities.flatMap((item, index) => (
    item.enabled ? [index] : []
  ))
  const currentCapabilityIndex = visibleCapabilities[selectedCapabilityIndex]?.enabled
    ? selectedCapabilityIndex
    : enabledCapabilityIndexes[0] ?? 0
  const capabilityPickerVisible = Boolean(
    capabilityLabels && (hasCapabilities || capabilityStatus !== 'ready'),
  )

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
    setShowFiles(false)
    setShowGitDiffs(false)
    setSelectedCapabilityIndex(0)
  }

  const closeAndInsert = (text: string) => {
    onInsert(text, 'command')
    close()
  }

  return (
    <div className="relative" ref={rootRef}>
      <Button
        aria-expanded={open}
        aria-label={t('kubecode.addContext')}
        className="h-8 w-8 shrink-0 rounded-full p-0"
        size="icon-sm"
        title={t('kubecode.addContext')}
        type="button"
        variant="ghost"
        onClick={() => {
          if (!open) {
            const composer = rootRef.current?.closest('[data-testid="agent-composer-surface"]')
            const composerRect = composer?.getBoundingClientRect()
            if (composerRect) {
              setPaletteLayout({
                bottom: window.innerHeight - composerRect.top + 12,
                left: composerRect.left,
                width: composerRect.width,
              })
            }
          }
          setOpen((current) => !current)
          setShowFiles(false)
          setShowGitDiffs(false)
        }}
      >
        <Plus size={19} />
      </Button>
      {open && (
        <section
          aria-label={t('kubecode.addContext')}
          className="fixed z-[100] flex max-h-[min(520px,58vh)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl"
          role="dialog"
          style={paletteLayout}
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
                  <CaretLeft />
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
                  <CaretLeft />
                  <span className="truncate">{t('kubecode.referenceGitDiff')}</span>
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {gitDiffState.status === 'loading' ? (
                  <p className="px-3 py-3 text-sm text-muted-foreground">{t('kubecode.loadingContext')}</p>
                ) : gitDiffState.status === 'error' ? (
                  <p className="px-3 py-3 text-sm text-destructive">{t('kubecode.contextLoadFailed')}</p>
                ) : gitDiffState.candidates.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted-foreground">{t('kubecode.gitDiffEmpty')}</p>
                ) : gitDiffState.candidates.map((candidate) => (
                  <Button
                    className="h-auto min-h-11 w-full justify-start gap-3 px-3 py-2 text-left"
                    disabled={!candidate.enabled}
                    key={candidate.path ?? 'all'}
                    onClick={() => {
                      if (!candidate.enabled) return
                      onGitDiff(candidate)
                      close()
                    }}
                    type="button"
                    variant="ghost"
                  >
                    <GitDiff className="shrink-0" size={20} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate font-medium">
                        {candidate.path?.split('/').at(-1) ?? gitDiffLabels.all}
                      </strong>
                      <small className="block whitespace-normal text-sm font-normal text-muted-foreground">
                        {candidate.enabled
                          ? gitDiffLabels.summary(candidate)
                          : gitDiffLabels.disabled(candidate.disabled_reason)}
                      </small>
                    </span>
                  </Button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <Button
                  className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-left"
                  onClick={() => setShowFiles(true)}
                  type="button"
                  variant="ghost"
                >
                  <File className="shrink-0" size={20} />
                  <span className="min-w-0">
                    <strong className="block truncate font-medium">{t('kubecode.referenceFile')}</strong>
                    <small className="block truncate text-sm font-normal text-muted-foreground">
                      {t('kubecode.chooseFileReference')}
                    </small>
                  </span>
                </Button>
                {gitDiffLabels && onGitDiff && <Button
                  className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-left"
                  onClick={() => {
                    setShowGitDiffs(true)
                    setGitDiffState({ candidates: [], status: 'loading' })
                    void api.listComposerGitDiffs(conversationId).then((result) => {
                      setGitDiffState({ candidates: result.candidates, status: 'ready' })
                    }).catch(() => setGitDiffState({ candidates: [], status: 'error' }))
                  }}
                  type="button"
                  variant="ghost"
                >
                  <GitDiff className="shrink-0" size={20} />
                  <span className="min-w-0">
                    <strong className="block truncate font-medium">{t('kubecode.referenceGitDiff')}</strong>
                    <small className="block whitespace-normal text-sm font-normal text-muted-foreground">
                      {t('kubecode.chooseGitDiffReference')}
                    </small>
                  </span>
                </Button>}
                {visibleCommands.map((command) => (
                  <Button
                    className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-left"
                    key={command.name}
                    onClick={() => closeAndInsert(`/${command.name} `)}
                    type="button"
                    variant="ghost"
                  >
                    <Sparkle className="shrink-0" size={20} />
                    <span className="min-w-0">
                      <strong className="block truncate font-medium">/{command.name}</strong>
                      {command.description && (
                        <small className="block truncate text-sm font-normal text-muted-foreground">
                          {command.description}
                        </small>
                      )}
                    </span>
                  </Button>
                ))}
                {capabilityLabels && capabilityPickerVisible && (
                  <div className="mt-1 border-t border-border pt-1">
                    <ComposerCapabilityPicker
                      embedded
                      id={capabilityListboxId}
                      items={visibleCapabilities}
                      labels={capabilityLabels}
                      onHover={setSelectedCapabilityIndex}
                      onSelect={(index) => {
                        const capability = visibleCapabilities[index]
                        if (!capability?.enabled || !onCapability) return
                        onCapability(capability)
                        close()
                      }}
                      selectedIndex={currentCapabilityIndex}
                      status={capabilityStatus}
                    />
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
                <Input
                  aria-activedescendant={capabilityPickerVisible
                    && visibleCapabilities[currentCapabilityIndex]?.enabled
                    ? `${capabilityListboxId}-option-${currentCapabilityIndex}`
                    : undefined}
                  aria-label={t('kubecode.searchContext')}
                  aria-controls={capabilityPickerVisible ? capabilityListboxId : undefined}
                  aria-expanded={capabilityPickerVisible}
                  aria-autocomplete={capabilityPickerVisible ? 'list' : undefined}
                  autoFocus
                  className="h-9 border-0 bg-transparent shadow-none focus-visible:ring-0"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      if (enabledCapabilityIndexes.length === 0) return
                      event.preventDefault()
                      const currentPosition = Math.max(
                        0,
                        enabledCapabilityIndexes.indexOf(currentCapabilityIndex),
                      )
                      const direction = event.key === 'ArrowDown' ? 1 : -1
                      const nextPosition = (
                        currentPosition + direction + enabledCapabilityIndexes.length
                      ) % enabledCapabilityIndexes.length
                      setSelectedCapabilityIndex(enabledCapabilityIndexes[nextPosition])
                    }
                    if ((event.key === 'Enter' || event.key === 'Tab')
                      && visibleCapabilities[currentCapabilityIndex]?.enabled
                      && onCapability) {
                      event.preventDefault()
                      onCapability(visibleCapabilities[currentCapabilityIndex])
                      close()
                    }
                  }}
                  placeholder={t('kubecode.searchContext')}
                  role={capabilityPickerVisible ? 'combobox' : undefined}
                  value={query}
                />
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}
