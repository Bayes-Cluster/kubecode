import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Translator } from '@/lib/i18n'

import type { AgentDescriptor, AgentId } from '../api'
import { agentName } from '../session/sessionModel'

/** A provider choice as a shadcn Select (ADR 0244): unavailable providers are listed but cannot be chosen. */
export function ProviderSelect({
  agents, describedBy, disabled, id, isSelectable, t, value, onChange,
}: {
  agents: readonly AgentDescriptor[]
  describedBy?: string
  disabled?: boolean
  id: string
  /** Whether an unavailable provider can stay chosen (the saved one, say). */
  isSelectable?: (agent: AgentDescriptor) => boolean
  t: Translator
  value: AgentId
  onChange: (agentId: AgentId) => void
}) {
  return (
    <Select disabled={disabled} value={value} onValueChange={(next) => onChange(next as AgentId)}>
      <SelectTrigger aria-describedby={describedBy} className="kubecode-member-select" id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {agents.map((agent) => (
            <SelectItem disabled={!(isSelectable?.(agent) ?? agent.available)} key={agent.id} value={agent.id}>
              {agentName(agent.id)}{agent.available ? '' : ` — ${t('kubecode.unavailable')}`}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
