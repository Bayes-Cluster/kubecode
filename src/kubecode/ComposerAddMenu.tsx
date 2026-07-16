import { CaretLeft, File, Plus, Sparkle } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TranslationKey } from '@/lib/i18n'

import type { KubecodeApi } from './api'
import { ProjectFileTree } from './ProjectFileTree'

export type ComposerAgentCommand = { name: string; description: string }

type ComposerAddMenuProps = {
  api: KubecodeApi
  commands: ComposerAgentCommand[]
  onInsert: (text: string, kind: 'command' | 'file') => void
  projectId: string
  t: (key: TranslationKey) => string
}

export function ComposerAddMenu({
  api,
  commands,
  onInsert,
  projectId,
  t,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [query, setQuery] = useState('')
  const [paletteLayout, setPaletteLayout] = useState({ left: 0, width: 680 })
  const rootRef = useRef<HTMLDivElement>(null)
  const visibleCommands = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    if (!search) return commands
    return commands.filter((command) => (
      command.name.toLocaleLowerCase().includes(search)
        || command.description.toLocaleLowerCase().includes(search)
    ))
  }, [commands, query])

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

  const closeAndInsert = (text: string, kind: 'command' | 'file') => {
    onInsert(text, kind)
    setOpen(false)
    setQuery('')
    setShowFiles(false)
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
            const rootRect = rootRef.current?.getBoundingClientRect()
            if (composerRect && rootRect) {
              setPaletteLayout({
                left: composerRect.left - rootRect.left,
                width: composerRect.width,
              })
            }
          }
          setOpen((current) => !current)
          setShowFiles(false)
        }}
      >
        <Plus size={19} />
      </Button>
      {open && (
        <section
          aria-label={t('kubecode.addContext')}
          className="absolute bottom-[calc(100%+12px)] left-0 z-50 flex max-h-[min(520px,58vh)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl"
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
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <ProjectFileTree
                  api={api}
                  onDirectoryChange={() => undefined}
                  onOpenFile={(entry) => closeAndInsert(`@${entry.path} `, 'file')}
                  projectId={projectId}
                  projectName={t('kubecode.files')}
                  refreshVersion={0}
                />
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
                {visibleCommands.map((command) => (
                  <Button
                    className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-left"
                    key={command.name}
                    onClick={() => closeAndInsert(`/${command.name} `, 'command')}
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
                {commands.length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {t('kubecode.noAgentSkillsCommands')}
                  </p>
                )}
              </div>
              <div className="border-t border-border p-2">
                <Input
                  aria-label={t('kubecode.searchContext')}
                  autoFocus
                  className="h-9 border-0 bg-transparent shadow-none focus-visible:ring-0"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('kubecode.searchContext')}
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
