import { CaretDown, CaretRight, Check } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { TranslationKey } from '@/lib/i18n'

export type AgentConfigGroup = {
  currentValue: string
  id: string
  name: string
  options: Array<{ id: string; name: string }>
}

type AgentConfigMenuProps = {
  groups: AgentConfigGroup[]
  onChange: (groupId: string, value: string) => void
  t: (key: TranslationKey) => string
}

function selectedOption(group: AgentConfigGroup): string {
  return group.options.find((option) => option.id === group.currentValue)?.name
    ?? group.currentValue
}

export function AgentConfigMenu({ groups, onChange, t }: AgentConfigMenuProps) {
  const [open, setOpen] = useState(false)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const primary = groups[0]
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null

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

  if (!primary) return null

  const select = (group: AgentConfigGroup, value: string) => {
    onChange(group.id, value)
    setOpen(false)
    setActiveGroupId(null)
  }

  const options = (group: AgentConfigGroup) => group.options.map((option) => (
    <Button
      className="h-10 w-full justify-between rounded-lg px-3 text-left font-normal"
      key={option.id}
      onClick={() => select(group, option.id)}
      type="button"
      variant="ghost"
    >
      <span className="truncate">{option.name}</span>
      {group.currentValue === option.id && <Check className="shrink-0" weight="bold" />}
    </Button>
  ))

  return (
    <div className="relative" ref={rootRef}>
      <Button
        aria-expanded={open}
        aria-label={t('kubecode.agentSettings')}
        className="h-8 max-w-48 gap-1.5 rounded-full bg-muted px-3 font-normal text-muted-foreground hover:text-foreground"
        onClick={() => {
          setOpen((current) => !current)
          setActiveGroupId(null)
        }}
        size="sm"
        title={t('kubecode.agentSettings')}
        type="button"
        variant="ghost"
      >
        <span className="truncate">{selectedOption(primary)}</span>
        <CaretDown className="shrink-0" />
      </Button>
      {open && (
        <div className="absolute bottom-[calc(100%+10px)] right-0 z-50">
          <section
            aria-label={t('kubecode.agentSettings')}
            className="max-h-[min(520px,calc(100vh-80px))] w-72 overflow-y-auto rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-xl"
            role="dialog"
          >
            <div className="px-3 py-2 text-sm text-muted-foreground">{primary.name}</div>
            {options(primary)}
            {groups.length > 1 && <div className="my-1 h-px bg-border" />}
            {groups.slice(1).map((group) => (
              <Button
                className="h-auto w-full justify-between gap-3 rounded-lg px-3 py-2.5 text-left font-normal"
                key={group.id}
                onClick={() => setActiveGroupId(group.id)}
                onPointerMove={() => setActiveGroupId(group.id)}
                type="button"
                variant="ghost"
              >
                <span className="min-w-0">
                  <strong className="block truncate font-normal">{selectedOption(group)}</strong>
                  <small className="block truncate text-xs text-muted-foreground">{group.name}</small>
                </span>
                <CaretRight className="shrink-0" />
              </Button>
            ))}
          </section>
          {activeGroup && (
            <section
              aria-label={activeGroup.name}
              className="absolute bottom-0 right-[calc(100%+8px)] max-h-[min(520px,calc(100vh-80px))] w-72 overflow-y-auto rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-xl"
              role="menu"
            >
              <div className="px-3 py-2 text-sm text-muted-foreground">{activeGroup.name}</div>
              {options(activeGroup)}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
