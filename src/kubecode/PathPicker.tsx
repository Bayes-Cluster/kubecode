import { ArrowRight, Plus } from '@phosphor-icons/react'
import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { ProjectEntryIcon } from './fileIcons'

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
  const listboxId = useId()
  const enabledRows = useMemo(() => rows.filter((row) => !row.disabled), [rows])
  const [activeId, setActiveId] = useState(enabledRows[0]?.id ?? null)
  const activeRow = enabledRows.find((row) => row.id === activeId) ?? enabledRows[0]

  const moveActive = (direction: 1 | -1) => {
    if (enabledRows.length === 0) return
    const currentIndex = Math.max(0, enabledRows.findIndex((row) => row.id === activeRow?.id))
    const nextIndex = (currentIndex + direction + enabledRows.length) % enabledRows.length
    setActiveId(enabledRows[nextIndex]?.id ?? null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' && activeRow) {
      event.preventDefault()
      onSelect(activeRow)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onEscape?.()
    }
  }

  return (
    <div className={cn('kubecode-path-picker', className)}>
      <Input
        aria-activedescendant={activeRow ? optionId(listboxId, activeRow.id) : undefined}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded="true"
        aria-label={ariaLabel}
        autoComplete="off"
        autoFocus
        className="kubecode-path-picker-input"
        placeholder={placeholder}
        role="combobox"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div
        aria-label={ariaLabel}
        className="kubecode-path-picker-results"
        id={listboxId}
        role="listbox"
      >
        {rows.map((row) => {
          const active = activeRow?.id === row.id
          return (
            <button
              aria-disabled={row.disabled || undefined}
              aria-selected={active}
              className="kubecode-path-picker-row"
              data-active={active || undefined}
              disabled={row.disabled}
              id={optionId(listboxId, row.id)}
              key={row.id}
              role="option"
              type="button"
              onClick={() => onSelect(row)}
              onMouseMove={() => {
                if (!row.disabled) setActiveId(row.id)
              }}
            >
              {row.icon ?? (
                row.kind === 'action'
                  ? <Plus />
                  : <ProjectEntryIcon kind={row.kind} name={row.label} />
              )}
              <span className="kubecode-path-picker-row-copy">
                <strong>{row.label}</strong>
                {row.description && <small>{row.description}</small>}
              </span>
              {row.kind === 'directory' && <ArrowRight className="kubecode-path-picker-row-action" />}
            </button>
          )
        })}
        {!loading && rows.length === 0 && (
          <div className="kubecode-path-picker-empty">{emptyMessage}</div>
        )}
        {loading && (
          <div className="kubecode-path-picker-empty">{loadingMessage ?? emptyMessage}</div>
        )}
      </div>
      {footer}
    </div>
  )
}

function optionId(listboxId: string, rowId: string): string {
  return `${listboxId}-option-${rowId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}
