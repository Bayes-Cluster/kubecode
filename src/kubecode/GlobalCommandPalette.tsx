import {
  PanelLeft,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sparkle,
  SquareTerminal,
  Zap,
} from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import { CommandMenuFeedback, CommandMenuPill, highlightMatch } from '@/components/agent-ui'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { ComposerCatalogSnapshot } from './api'
import {
  commandPaletteCatalogGroups,
  commandPaletteMatchRank,
  type RankedCommandPaletteItem,
} from './commandPalette'
import type { RegisteredHostAction } from './hostActions'

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
  if (id === 'add-project' || id === 'new-session') return <Plus aria-hidden  size={16}/>
  if (id === 'open-settings') return <Settings aria-hidden  size={16}/>
  if (id === 'focus-session-search') return <Search aria-hidden  size={16}/>
  if (id === 'toggle-terminal') return <SquareTerminal aria-hidden  size={16}/>
  return <PanelLeft aria-hidden  size={16}/>
}

function CatalogItemIcon({ item }: { item: RankedCommandPaletteItem }) {
  if (item.kind === 'command') return <Sparkle aria-hidden  size={16}/>
  if (item.kind === 'plugin_action') return <Puzzle aria-hidden  size={16}/>
  return <Zap aria-hidden  size={16}/>
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

function PaletteOption({
  query,
  row,
  onSelect,
  t,
}: {
  query: string
  row: PaletteRow
  onSelect: () => void
  t: Translator
}) {
  const reasonId = useId()
  return (
    <CommandItem
      aria-describedby={!row.enabled ? reasonId : undefined}
      className="agx-cmd__item items-start"
      disabled={!row.enabled}
      onSelect={onSelect}
      value={row.key}
    >
      {row.group === 'host'
        ? <HostActionIcon id={row.action.id} />
        : <CatalogItemIcon item={row.item} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="min-w-0 max-w-full truncate font-medium">
            {highlightMatch(row.group === 'command' ? `/${row.label}` : row.label, query)}
          </span>
          {row.group !== 'host' && (
            <>
              <Badge variant="outline">{itemKindLabel(row.item, t)}</Badge>
              <Badge className="max-w-full truncate" variant="outline">{row.item.source_label}</Badge>
              <Badge variant="outline">{itemScopeLabel(row.item, t)}</Badge>
            </>
          )}
        </div>
        {row.group !== 'host' && row.item.description && (
          <span className="truncate text-xs text-muted-foreground">{highlightMatch(row.item.description, query)}</span>
        )}
        {!row.enabled && row.disabledReason && (
          <span className="text-xs text-destructive" id={reasonId}>{row.disabledReason}</span>
        )}
      </div>
    </CommandItem>
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
  const [ranLabel, setRanLabel] = useState<string | null>(null)
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
  const select = (row: PaletteRow) => {
    if (!row.enabled) return
    setQuery('')
    setRanLabel(row.label)
    if (row.group === 'host') onHostAction(row.action)
    else onCatalogItem(row.item)
  }

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) setQuery('')
    else setRanLabel(null)
    onOpenChange(nextOpen)
  }

  const renderRows = (group: PaletteRow['group'], label: string) => {
    const matching = rows.filter((row) => row.group === group)
    if (matching.length === 0) return null
    return (
      <CommandGroup heading={label}>
        {matching.map((row) => (
          <PaletteOption key={row.key} onSelect={() => select(row)} query={query} row={row} t={t} />
        ))}
      </CommandGroup>
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
        {/* The ranking is shared with the composer, so cmdk does not filter again. */}
        <Command label={t('command.palettePlaceholder')} shouldFilter={false}>
          <CommandInput
            aria-label={t('command.palettePlaceholder')}
            autoFocus
            className="h-12"
            onValueChange={setQuery}
            placeholder={t('command.palettePlaceholder')}
            value={query}
          />
          <CommandList className="agx-cmd__list max-h-[min(32rem,calc(100vh-5rem))]">
            <CommandMenuPill />
            {renderRows('host', t('kubecode.commandPaletteHostActions'))}
            {renderRows('command', t('kubecode.commandPaletteAgentCommands'))}
            {renderRows('capability', t('kubecode.commandPaletteCapabilities'))}
            {renderRows('plugin', t('kubecode.commandPalettePluginActions'))}
            {catalogStatus === 'loading' && (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground" role="status">
                <Spinner aria-hidden="true" />
                {t('kubecode.loadingCapabilities')}
              </div>
            )}
            {catalogStatus === 'error' && (
              <Alert className="m-2 w-auto" variant="destructive">
                <AlertTitle>{t('kubecode.capabilitiesLoadFailed')}</AlertTitle>
              </Alert>
            )}
            {!catalog && catalogStatus === 'ready' && sessionDisabledReason && (
              <p className="px-3 py-3 text-sm text-muted-foreground" role="status">
                {sessionDisabledReason}
              </p>
            )}
            {rows.length === 0 && catalogStatus === 'ready' && (
              <CommandEmpty role="status">{t('command.noMatches')}</CommandEmpty>
            )}
          </CommandList>
          <CommandMenuFeedback
            hint={
              <>
                <kbd>↵</kbd> {t('kubecode.commandPaletteHintSelect')}
                {' · '}
                <kbd>esc</kbd> {t('kubecode.commandPaletteHintClose')}
              </>
            }
            ranLabel={ranLabel}
          />
        </Command>
      </DialogContent>
    </Dialog>
  )
}
