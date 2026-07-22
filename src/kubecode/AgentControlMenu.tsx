import { CaretDown, CaretRight, Check, LockSimple, ToggleLeft, ToggleRight } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import type { TranslationKey } from '@/lib/i18n'

import type { AgentId } from './api'
import type { NativeSessionConfig, NativeSessionSelect } from './agentSessionOptions'

type AgentControlMenuProps = {
  agent: AgentId
  configs: NativeSessionConfig[]
  mode: NativeSessionSelect | null
  modeDisabled: boolean
  modeDisabledReason?: string
  onConfigChange: (configId: string, value: string | boolean) => void
  onModeChange: (value: string) => void
  t: (key: TranslationKey) => string
}

function selectedOption(group: NativeSessionSelect): string {
  return group.options.find((option) => option.id === group.currentValue)?.name
    ?? group.currentValue
}

export function AgentControlMenu({
  agent,
  configs,
  mode,
  modeDisabled,
  modeDisabledReason,
  onConfigChange,
  onModeChange,
  t,
}: AgentControlMenuProps) {
  const [open, setOpen] = useState(false)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [position, setPosition] = useState({ bottom: 8, maxHeight: 520, right: 8 })
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectGroups = [mode, ...configs.filter((config) => config.type === 'select')]
    .filter((group): group is NativeSessionSelect => Boolean(group))
  const activeGroup = selectGroups.find((group) => group.id === activeGroupId) ?? null
  const modeName = mode ? selectedOption(mode) : t('kubecode.agentSettings')

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
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

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const trigger = rootRef.current?.getBoundingClientRect()
      if (!trigger) return
      setPosition({
        bottom: Math.max(8, window.innerHeight - trigger.top + 10),
        maxHeight: Math.max(96, Math.min(520, trigger.top - 18)),
        right: Math.max(8, window.innerWidth - trigger.right),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  if (!mode && configs.length === 0) return null

  const select = (group: NativeSessionSelect, value: string) => {
    if (group.kind === 'mode') onModeChange(value)
    else onConfigChange(group.id, value)
    setOpen(false)
    setActiveGroupId(null)
  }

  return (
    <div className="relative min-w-8 max-w-44 shrink" ref={rootRef}>
      <Button
        aria-expanded={open}
        aria-label={t('kubecode.agentSettings')}
        className="h-8 w-full min-w-8 gap-1.5 rounded-full bg-muted px-2.5 font-normal text-muted-foreground hover:text-foreground"
        onClick={() => {
          setOpen((current) => !current)
          setActiveGroupId(null)
        }}
        size="sm"
        title={t('kubecode.agentSettings')}
        type="button"
        variant="ghost"
      >
        <AiAgentIcon agent={agent} size={14} />
        <span className="min-w-0 truncate">{modeName}</span>
        <CaretDown className="shrink-0" />
      </Button>
      {open && createPortal(
        <div
          className="fixed z-[100]"
          ref={menuRef}
          style={{ bottom: position.bottom, right: position.right }}
        >
          <section
            aria-label={t('kubecode.agentSettings')}
            className="max-h-[min(520px,calc(100vh-80px))] w-72 overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
            role="dialog"
            style={{ maxHeight: position.maxHeight }}
          >
            {mode && (
              <Button
                className="h-auto w-full justify-between gap-3 rounded-md px-3 py-2.5 text-left font-normal"
                disabled={modeDisabled}
                onClick={() => setActiveGroupId(mode.id)}
                title={modeDisabled ? modeDisabledReason : undefined}
                type="button"
                variant="ghost"
              >
                <span className="min-w-0">
                  <strong className="block truncate font-normal">{selectedOption(mode)}</strong>
                  <small className="block truncate text-xs text-muted-foreground">{t('kubecode.agentMode')}</small>
                </span>
                {modeDisabled ? <LockSimple className="shrink-0" /> : <CaretRight className="shrink-0" />}
              </Button>
            )}
            {mode && configs.length > 0 && <div className="my-1 h-px bg-border" />}
            {configs.map((config) => config.type === 'boolean' ? (
              <Button
                aria-pressed={config.currentValue}
                className="h-auto w-full justify-between gap-3 rounded-md px-3 py-2.5 text-left font-normal"
                key={config.id}
                onClick={() => onConfigChange(config.id, !config.currentValue)}
                type="button"
                variant="ghost"
              >
                <span className="truncate">{config.name}</span>
                {config.currentValue
                  ? <ToggleRight className="shrink-0 text-primary" size={22} weight="fill" />
                  : <ToggleLeft className="shrink-0 text-muted-foreground" size={22} />}
              </Button>
            ) : (
              <Button
                className="h-auto w-full justify-between gap-3 rounded-md px-3 py-2.5 text-left font-normal"
                key={config.id}
                onClick={() => setActiveGroupId(config.id)}
                type="button"
                variant="ghost"
              >
                <span className="min-w-0">
                  <strong className="block truncate font-normal">{selectedOption(config)}</strong>
                  <small className="block truncate text-xs text-muted-foreground">{config.name}</small>
                </span>
                <CaretRight className="shrink-0" />
              </Button>
            ))}
          </section>
          {activeGroup && (
            <section
              aria-label={activeGroup.kind === 'mode' ? t('kubecode.agentMode') : activeGroup.name}
              className="absolute bottom-0 right-[calc(100%+8px)] max-h-[min(520px,calc(100vh-80px))] w-72 overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
              role="menu"
              style={{ maxHeight: position.maxHeight }}
            >
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {activeGroup.kind === 'mode' ? t('kubecode.agentMode') : activeGroup.name}
              </div>
              {activeGroup.options.map((option) => (
                <Button
                  className="h-auto min-h-10 w-full justify-between gap-3 rounded-md px-3 py-2 text-left font-normal"
                  key={option.id}
                  onClick={() => select(activeGroup, option.id)}
                  type="button"
                  variant="ghost"
                >
                  <span className="min-w-0">
                    <strong className="block font-normal">{option.name}</strong>
                    {option.description && (
                      <small className="block whitespace-normal text-xs text-muted-foreground">
                        {option.description}
                      </small>
                    )}
                  </span>
                  {activeGroup.currentValue === option.id && <Check className="shrink-0" weight="bold" />}
                </Button>
              ))}
            </section>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
