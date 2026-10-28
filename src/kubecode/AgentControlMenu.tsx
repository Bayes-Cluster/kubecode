import { AiAgentIcon } from '@/components/AiAgentIcon'
import {
  AgxModelPickerOption,
  AgxModelPickerToggle,
  AgxModelPickerTrigger,
  AgxPickerFill,
} from '@/components/agent-ui'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDown, Lock } from 'lucide-react'
import type { Translator } from '@/lib/i18n'

import type { AgentId } from './api'
import type { NativeSessionConfig, NativeSessionSelect } from './agentSessionOptions'

/**
 * The session's control menu, presented as the affectUI "Model Picker"
 * (ADR 0257; slice E1): one quiet trigger pill opening one panel where the
 * provider's own options are disclosed inline — the mode as selectable rows
 * with the provider's descriptions, boolean configs as switch toggles —
 * instead of the sub-menus it had before. The Radix menu stays the engine:
 * its arrows, typeahead and focus semantics own the panel; the fill glides
 * along its highlighted row. The provider catalog is the only content
 * (ADR 0257 §3): no capability meters, no prices, no hosted defaults.
 */

type AgentControlMenuProps = {
  agent: AgentId
  configs: NativeSessionConfig[]
  mode: NativeSessionSelect | null
  modeDisabled: boolean
  modeDisabledReason?: string
  onConfigChange: (configId: string, value: string | boolean) => void
  onModeChange: (value: string) => void
  t: Translator
}

function selectedOption(group: NativeSessionSelect): string {
  return group.options.find((option) => option.id === group.currentValue)?.name
    ?? group.currentValue
}

/** One select group, disclosed inline: label, then its options as rows. */
function SelectRows({
  group,
  label,
  onSelect,
}: {
  group: NativeSessionSelect
  label: string
  onSelect: (value: string) => void
}) {
  return (
    <DropdownMenuRadioGroup value={group.currentValue} onValueChange={onSelect}>
      <DropdownMenuLabel asChild>
        <div className="agx-pick__group-label">{label}</div>
      </DropdownMenuLabel>
      {group.options.map((option) => (
        <DropdownMenuRadioItem
          className="agx-pick__slot focus:bg-transparent focus:text-inherit"
          key={option.id}
          value={option.id}
        >
          <AgxModelPickerOption description={option.description ?? undefined} name={option.name} />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
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
  if (!mode && configs.length === 0) return null
  const modeName = mode ? selectedOption(mode) : t('kubecode.agentSettings')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t('kubecode.agentSettings')}
          className="max-w-44"
          size="sm"
          title={t('kubecode.agentSettings')}
          type="button"
          variant="ghost"
        >
          <AgxModelPickerTrigger
            chevron={<ChevronDown size={14} />}
            glyph={<AiAgentIcon agent={agent} size={14} />}
            name={modeName}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={t('kubecode.agentSettings')}
        align="end"
        className="w-80"
        side="top"
      >
        <div className="agx-pick__list">
          <AgxPickerFill selector="[data-highlighted]" />
          {mode && (
            modeDisabled ? (
              <DropdownMenuItem
              className="agx-pick__slot focus:bg-transparent focus:text-inherit"
              disabled
              title={modeDisabledReason}
            >
                <AgxModelPickerOption
                  check={<Lock className="agx-mpick__lock" size={14} />}
                  description={t('kubecode.agentMode')}
                  name={selectedOption(mode)}
                />
              </DropdownMenuItem>
            ) : (
              <SelectRows group={mode} label={t('kubecode.agentMode')} onSelect={onModeChange} />
            )
          )}
          {mode && configs.length > 0 && <DropdownMenuSeparator />}
          {configs.map((config) => config.type === 'boolean' ? (
            <DropdownMenuCheckboxItem
              checked={config.currentValue}
              className="agx-pick__slot focus:bg-transparent focus:text-inherit"
              key={config.id}
              onCheckedChange={(checked) => onConfigChange(config.id, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <AgxModelPickerToggle label={config.name} />
            </DropdownMenuCheckboxItem>
          ) : (
            <SelectRows
              group={config}
              key={config.id}
              label={config.name}
              onSelect={(value) => onConfigChange(config.id, value)}
            />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
