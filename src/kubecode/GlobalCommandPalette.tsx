import {
  Gear,
  Lightning,
  MagnifyingGlass,
  Plus,
  PuzzlePiece,
  SidebarSimple,
  Sparkle,
  TerminalWindow,
} from '@phosphor-icons/react'
import { useId, useMemo, useState, type ReactNode } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { TranslationKey, TranslationValues } from '@/lib/i18n'

import type { ComposerCatalogSnapshot } from './api'
import {
  commandPaletteCatalogGroups,
  commandPaletteMatchRank,
  type RankedCommandPaletteItem,
} from './commandPalette'
import type { RegisteredHostAction } from './hostActions'

type Translator = (key: TranslationKey, values?: TranslationValues) => string

const SCOPE_LABEL_KEYS: Record<RankedCommandPaletteItem['scope'], TranslationKey> = {
  bundled: 'kubecode.capabilityScopeBundled',
  plugin: 'kubecode.capabilityScopePlugin',
  project: 'kubecode.capabilityScopeProject',
  session: 'kubecode.capabilityScopeSession',
  user: 'kubecode.capabilityScopeUser',
}

type PaletteRow =
  | {
      action: RegisteredHostAction
      disabledReason: string | null
      enabled: boolean
      group: 'host'
      key: string
      label: string
    }
  | {
      disabledReason: string | null
      enabled: boolean
      group: 'command' | 'capability' | 'plugin'
      item: RankedCommandPaletteItem
      key: string
      label: string
    }

function HostActionIcon({ id }: { id: RegisteredHostAction['id'] }) {
  if (id === 'add-project' || id === 'new-session') return <Plus aria-hidden />
  if (id === 'open-settings') return <Gear aria-hidden />
  if (id === 'focus-session-search') return <MagnifyingGlass aria-hidden />
  if (id === 'toggle-terminal') return <TerminalWindow aria-hidden />
  return <SidebarSimple aria-hidden />
}

function CatalogItemIcon({ item }: { item: RankedCommandPaletteItem }) {
  if (item.kind === 'command') return <Sparkle aria-hidden />
  if (item.kind === 'plugin_action') return <PuzzlePiece aria-hidden />
  return <Lightning aria-hidden />
}

function catalogDisabledReason(item: RankedCommandPaletteItem, t: Translator): string {
  if (item.kind === 'command') return t('kubecode.unavailable')
  if (item.disabled_reason === 'ambiguous_source_identity') {
    return t('kubecode.capabilityDisabledAmbiguous')
  }
  if (item.disabled_reason === 'unsupported_input'
    || item.disabled_reason === 'unsupported_invocation') {
    return t('kubecode.capabilityDisabledUnsupported')
  }
  return t('kubecode.capabilityDisabledUnavailable')
}

function itemKindLabel(item: RankedCommandPaletteItem, t: Translator): string {
  if (item.kind === 'skill') return t('kubecode.capabilityKindSkill')
  if (item.kind === 'plugin_action') return t('kubecode.capabilityKindPluginAction')
  if (item.kind === 'provider_app') return t('kubecode.capabilityKindProviderApp')
  return t('kubecode.commandPaletteAgentCommands')
}

function itemScopeLabel(item: RankedCommandPaletteItem, t: Translator): string {
  return t(SCOPE_LABEL_KEYS[item.scope])
}

function PaletteGroup({
  children,
  id,
  label,
}: {
  children: ReactNode
  id: string
  label: string
}) {
  return (
    <section aria-labelledby={id} className="min-w-0" role="group">
      <h3 className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground" id={id}>
        {label}
      </h3>
      {children}
    </section>
  )
}

function PaletteOption({
  active,
  id,
  onHover,
  onSelect,
  row,
  t,
}: {
  active: boolean
  id: string
  onHover: () => void
  onSelect: () => void
  row: PaletteRow
  t: Translator
}) {
  const reasonId = `${id}-reason`
  return (
    <button
      aria-describedby={!row.enabled ? reasonId : undefined}
      aria-disabled={!row.enabled}
      aria-selected={active}
      className={cn(
        'flex min-h-12 w-full min-w-0 items-start gap-2 px-3 py-2 text-left outline-none',
        row.enabled && active && 'bg-accent text-accent-foreground',
        row.enabled && !active && 'hover:bg-accent/60',
        !row.enabled && 'cursor-not-allowed opacity-65',
      )}
      id={id}
      onClick={() => row.enabled && onSelect()}
      onMouseEnter={() => row.enabled && onHover()}
      onPointerMove={() => row.enabled && onHover()}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <span className="mt-0.5 shrink-0 [&>svg]:size-4">
        {row.group === 'host'
          ? <HostActionIcon id={row.action.id} />
          : <CatalogItemIcon item={row.item} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <strong className="min-w-0 max-w-full truncate text-sm font-medium">
            {row.group === 'command' ? `/${row.label}` : row.label}
          </strong>
          {row.group !== 'host' && (
            <>
              <span className="rounded-sm border border-border px-1 text-[10px] text-muted-foreground">
                {itemKindLabel(row.item, t)}
              </span>
              <span className="max-w-full truncate rounded-sm border border-border px-1 text-[10px] text-muted-foreground">
                {row.item.source_label}
              </span>
              <span className="rounded-sm border border-border px-1 text-[10px] text-muted-foreground">
                {itemScopeLabel(row.item, t)}
              </span>
            </>
          )}
        </span>
        {row.group !== 'host' && row.item.description && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {row.item.description}
          </span>
        )}
        {!row.enabled && row.disabledReason && (
          <span className="mt-0.5 block text-xs text-destructive" id={reasonId}>
            {row.disabledReason}
          </span>
        )}
      </span>
    </button>
  )
}

export function GlobalCommandPalette({
  catalog,
  catalogStatus,
  hostActions,
  onCatalogItem,
  onCloseAutoFocus,
  onHostAction,
  onOpenChange,
  open,
  sessionDisabledReason,
  sessionWritable,
  t,
}: {
  catalog: ComposerCatalogSnapshot | null
  catalogStatus: 'error' | 'loading' | 'ready'
  hostActions: RegisteredHostAction[]
  onCatalogItem: (item: RankedCommandPaletteItem) => void
  onCloseAutoFocus?: (event: Event) => void
  onHostAction: (action: RegisteredHostAction) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  sessionDisabledReason: string | null
  sessionWritable: boolean
  t: Translator
}) {
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const listboxId = useId()
  const groupIdPrefix = useId()
  const catalogGroups = useMemo(
    () => commandPaletteCatalogGroups(catalog, query),
    [catalog, query],
  )
  const hostRows = useMemo(() => hostActions
    .flatMap((action) => {
      const label = t(action.labelKey)
      const rank = commandPaletteMatchRank(label, null, query)
      return rank === null ? [] : [{ action, label, rank }]
    })
    .sort((left, right) => left.rank - right.rank), [hostActions, query, t])
  const rows = useMemo<PaletteRow[]>(() => [
    ...hostRows.map(({ action, label }) => ({
      action,
      disabledReason: action.disabledReasonKey ? t(action.disabledReasonKey) : null,
      enabled: action.enabled,
      group: 'host' as const,
      key: `host:${action.id}`,
      label,
    })),
    ...catalogGroups.commands.map((item) => ({
      disabledReason: sessionDisabledReason ?? (!item.enabled ? catalogDisabledReason(item, t) : null),
      enabled: sessionWritable && item.enabled,
      group: 'command' as const,
      item,
      key: `catalog:${item.kind}:${item.id}`,
      label: item.name,
    })),
    ...catalogGroups.capabilities.map((item) => ({
      disabledReason: sessionDisabledReason ?? (!item.enabled ? catalogDisabledReason(item, t) : null),
      enabled: sessionWritable && item.enabled,
      group: 'capability' as const,
      item,
      key: `catalog:${item.kind}:${item.id}`,
      label: `$${item.name}`,
    })),
    ...catalogGroups.pluginActions.map((item) => ({
      disabledReason: sessionDisabledReason ?? (!item.enabled ? catalogDisabledReason(item, t) : null),
      enabled: sessionWritable && item.enabled,
      group: 'plugin' as const,
      item,
      key: `catalog:${item.kind}:${item.id}`,
      label: item.name,
    })),
  ], [catalogGroups, hostRows, sessionDisabledReason, sessionWritable, t])
  const enabledRows = rows.filter((row) => row.enabled)
  const selectedRow = rows.find((row) => row.key === selectedKey && row.enabled)
    ?? enabledRows[0]
    ?? null

  const select = (row: PaletteRow) => {
    if (!row.enabled) return
    setQuery('')
    setSelectedKey(null)
    if (row.group === 'host') onHostAction(row.action)
    else onCatalogItem(row.item)
  }

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery('')
      setSelectedKey(null)
    }
    onOpenChange(nextOpen)
  }

  const renderRows = (group: PaletteRow['group'], label: string) => {
    const matching = rows.filter((row) => row.group === group)
    if (matching.length === 0) return null
    const groupId = `${groupIdPrefix}-${group}`
    return (
      <PaletteGroup id={groupId} label={label}>
        {matching.map((row) => (
          <PaletteOption
            active={row.key === selectedRow?.key}
            id={`${listboxId}-${row.key}`}
            key={row.key}
            onHover={() => setSelectedKey(row.key)}
            onSelect={() => select(row)}
            row={row}
            t={t}
          />
        ))}
      </PaletteGroup>
    )
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        aria-label={t('menu.view.commandPalette')}
        className="max-h-[min(38rem,calc(100vh-1rem))] w-[min(44rem,calc(100vw-1rem))] max-w-none gap-0 overflow-hidden p-0"
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('menu.view.commandPalette')}</DialogTitle>
          <DialogDescription>{t('command.palettePlaceholder')}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-3">
          <MagnifyingGlass aria-hidden className="shrink-0 text-muted-foreground" />
          <Input
            aria-activedescendant={selectedRow ? `${listboxId}-${selectedRow.key}` : undefined}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={open}
            aria-label={t('command.palettePlaceholder')}
            autoFocus
            className="h-12 min-w-0 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedKey(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (enabledRows.length === 0) return
                event.preventDefault()
                const currentIndex = Math.max(0, enabledRows.findIndex((row) => row.key === selectedRow?.key))
                const direction = event.key === 'ArrowDown' ? 1 : -1
                const next = (currentIndex + direction + enabledRows.length) % enabledRows.length
                setSelectedKey(enabledRows[next].key)
              }
              if (event.key === 'Home' || event.key === 'End') {
                if (enabledRows.length === 0) return
                event.preventDefault()
                setSelectedKey(enabledRows[event.key === 'Home' ? 0 : enabledRows.length - 1].key)
              }
              if (event.key === 'Enter' && selectedRow) {
                event.preventDefault()
                select(selectedRow)
              }
            }}
            placeholder={t('command.palettePlaceholder')}
            role="combobox"
            value={query}
          />
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto py-1" id={listboxId} role="listbox">
          {renderRows('host', t('kubecode.commandPaletteHostActions'))}
          {renderRows('command', t('kubecode.commandPaletteAgentCommands'))}
          {renderRows('capability', t('kubecode.commandPaletteCapabilities'))}
          {renderRows('plugin', t('kubecode.commandPalettePluginActions'))}
          {catalogStatus === 'loading' && (
            <p className="px-3 py-3 text-sm text-muted-foreground" role="status">
              {t('kubecode.loadingCapabilities')}
            </p>
          )}
          {catalogStatus === 'error' && (
            <p className="px-3 py-3 text-sm text-destructive" role="status">
              {t('kubecode.capabilitiesLoadFailed')}
            </p>
          )}
          {!catalog && catalogStatus === 'ready' && sessionDisabledReason && (
            <p className="px-3 py-3 text-sm text-muted-foreground" role="status">
              {sessionDisabledReason}
            </p>
          )}
          {rows.length === 0 && catalogStatus === 'ready' && (
            <p className="px-3 py-3 text-sm text-muted-foreground" role="status">
              {t('command.noMatches')}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
