import { ArrowRight, Plus } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'

import { MaterialDirectoryIcon } from './icons/material/materialIcons'
import { MaterialFileIcon } from './icons/material/materialIcons'
import { resolveFileIcon } from './icons/resolveFileIcon'
export type PathPickerRow = {
  description?: string
  disabled?: boolean
  icon?: ReactNode
  id: string
  kind: 'action' | 'directory' | 'file'
  label: string
  path: string
}

type PathPickerProps = {
  ariaLabel: string
  className?: string
  emptyMessage: string
  footer?: ReactNode
  loading?: boolean
  loadingMessage?: string
  onEscape?: () => void
  onQueryChange: (query: string) => void
  onSelect: (row: PathPickerRow) => void
  placeholder: string
  query: string
  rows: PathPickerRow[]
}

/**
 * A typed path with matching rows below it, on the official Command: cmdk
 * owns the combobox, the active row, arrow keys and Enter. The rows come
 * from the server, so Command's own filtering is off.
 */
export function PathPicker({
  ariaLabel,
  className,
  emptyMessage,
  footer,
  loading = false,
  loadingMessage,
  onEscape,
  onQueryChange,
  onSelect,
  placeholder,
  query,
  rows,
}: PathPickerProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && onEscape) {
      event.preventDefault()
      onEscape()
    }
  }

  return (
    <Command
      className={cn('min-h-0 bg-transparent', className)}
      label={ariaLabel}
      loop
      shouldFilter={false}
      onKeyDown={onKeyDown}
    >
      <CommandInput
        autoComplete="off"
        autoFocus
        placeholder={placeholder}
        value={query}
        onValueChange={onQueryChange}
      />
      <CommandList aria-label={ariaLabel} className="max-h-[min(360px,50dvh)]">
        {loading
          ? <p className="py-6 text-center text-sm text-muted-foreground" role="status">{loadingMessage ?? emptyMessage}</p>
          : <CommandEmpty>{emptyMessage}</CommandEmpty>}
        {rows.length > 0 && (
          <CommandGroup>
            {rows.map((row) => (
              <CommandItem
                disabled={row.disabled}
                key={row.id}
                value={row.id}
                onSelect={() => onSelect(row)}
              >
                {row.icon ?? (
                  row.kind === 'action'
                    ? <Plus />
                    : row.kind === 'directory'
                      ? <MaterialDirectoryIcon name={row.label} />
                      : <MaterialFileIcon id={resolveFileIcon(row.label)} />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{row.label}</span>
                  {row.description && (
                    <span className="truncate text-xs text-muted-foreground">{row.description}</span>
                  )}
                </span>
                {row.kind === 'directory' && <ArrowRight />}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      {footer}
    </Command>
  )
}
