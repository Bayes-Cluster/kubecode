import { ChevronDown, Lock } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Translator } from '@/lib/i18n'

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
  t: Translator
}

function selectedOption(group: NativeSessionSelect): string {
  return group.options.find((option) => option.id === group.currentValue)?.name
    ?? group.currentValue
}

function SelectSubMenu({
  group,
  label,
  onSelect,
}: {
  group: NativeSessionSelect
  label: string
  onSelect: (value: string) => void
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{selectedOption(group)}</span>
          <span className="truncate text-xs text-muted-foreground">{label}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="max-h-(--radix-dropdown-menu-content-available-height) w-72 overflow-y-auto"
      >
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={group.currentValue} onValueChange={onSelect}>
          {group.options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              <span className="flex min-w-0 flex-col">
                <span>{option.name}</span>
                {option.description && (
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
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
          className="min-w-8 max-w-44 shrink"
          size="sm"
          title={t('kubecode.agentSettings')}
          type="button"
          variant="secondary"
        >
          <AiAgentIcon agent={agent} size={14} />
          <span className="min-w-0 truncate">{modeName}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={t('kubecode.agentSettings')} align="end" className="w-72" side="top">
        {mode && (
          <DropdownMenuGroup>
            {modeDisabled ? (
              <DropdownMenuItem disabled title={modeDisabledReason}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{selectedOption(mode)}</span>
                  <span className="truncate text-xs text-muted-foreground">{t('kubecode.agentMode')}</span>
                </span>
                <Lock />
              </DropdownMenuItem>
            ) : (
              <SelectSubMenu group={mode} label={t('kubecode.agentMode')} onSelect={onModeChange} />
            )}
          </DropdownMenuGroup>
        )}
        {mode && configs.length > 0 && <DropdownMenuSeparator />}
        {configs.length > 0 && (
          <DropdownMenuGroup>
            {configs.map((config) => config.type === 'boolean' ? (
              <DropdownMenuCheckboxItem
                checked={config.currentValue}
                key={config.id}
                onCheckedChange={(checked) => onConfigChange(config.id, checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                {config.name}
              </DropdownMenuCheckboxItem>
            ) : (
              <SelectSubMenu
                group={config}
                key={config.id}
                label={config.name}
                onSelect={(value) => onConfigChange(config.id, value)}
              />
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
