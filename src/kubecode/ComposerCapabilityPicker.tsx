import { AppWindow, Puzzle, Zap } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { ComposerCatalogItem } from './api'
import type { RankedComposerCapability } from './composerCapabilities'

export type ComposerCapabilityPickerLabels = {
  disabledReason: (reason: string | null) => string
  empty: string
  error: string
  kind: Record<Exclude<ComposerCatalogItem['kind'], 'command'>, string>
  loading: string
  picker: string
  scope: Record<ComposerCatalogItem['scope'], string>
}

function CapabilityIcon({ kind }: { kind: RankedComposerCapability['kind'] }) {
  if (kind === 'plugin_action') return <Puzzle aria-hidden className="shrink-0" size={17} />
  if (kind === 'provider_app') return <AppWindow aria-hidden className="shrink-0" size={17} />
  return <Zap aria-hidden className="shrink-0" size={17} />
}

export function ComposerCapabilityPicker({
  embedded = false,
  id,
  items,
  labels,
  onHover,
  onSelect,
  selectedIndex,
  status,
}: {
  embedded?: boolean
  id: string
  items: RankedComposerCapability[]
  labels: ComposerCapabilityPickerLabels
  onHover: (index: number) => void
  onSelect: (index: number) => void
  selectedIndex: number
  status: 'error' | 'loading' | 'ready'
}) {
  return (
    <div
      aria-busy={status === 'loading'}
      aria-label={labels.picker}
      aria-live="polite"
      className={cn(
        'max-h-72 min-w-0 overflow-y-auto p-1 text-popover-foreground',
        !embedded && 'absolute bottom-full left-0 right-0 z-20 mb-1 rounded-md border border-border bg-popover shadow-lg',
      )}
      data-testid="composer-capability-menu"
      id={id}
      role="listbox"
    >
      {status === 'loading' ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{labels.loading}</p>
      ) : status === 'error' ? (
        <p className="px-3 py-3 text-sm text-destructive">{labels.error}</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{labels.empty}</p>
      ) : items.map((item, index) => {
        const reasonId = `${id}-option-${index}-reason`
        return (
          <button
            aria-describedby={!item.enabled ? reasonId : undefined}
            aria-disabled={!item.enabled}
            aria-selected={index === selectedIndex}
            className={cn(
              'flex min-h-12 w-full min-w-0 items-start gap-2 rounded-sm px-2 py-2 text-left',
              item.enabled && index === selectedIndex && 'bg-accent text-accent-foreground',
              item.enabled && index !== selectedIndex && 'hover:bg-accent/60',
              !item.enabled && 'cursor-not-allowed opacity-65',
            )}
            disabled={!item.enabled}
            id={`${id}-option-${index}`}
            key={item.id}
            onClick={() => onSelect(index)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => item.enabled && onHover(index)}
            onPointerDown={(event) => event.pointerType === 'touch' && event.preventDefault()}
            role="option"
            type="button"
          >
            <CapabilityIcon kind={item.kind} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                <strong className="min-w-0 max-w-full truncate text-sm font-medium">${item.name}</strong>
                <span className="rounded-sm border border-border px-1 text-[10px] text-muted-foreground">
                  {labels.kind[item.kind]}
                </span>
                <span className="max-w-full truncate rounded-sm border border-border px-1 text-[10px] text-muted-foreground">
                  {item.source_label}
                </span>
                <span className="rounded-sm border border-border px-1 text-[10px] text-muted-foreground">
                  {labels.scope[item.scope]}
                </span>
              </span>
              {item.description && (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {item.description}
                </span>
              )}
              {!item.enabled && (
                <span className="mt-0.5 block text-xs text-destructive" id={reasonId}>
                  {labels.disabledReason(item.disabled_reason)}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
