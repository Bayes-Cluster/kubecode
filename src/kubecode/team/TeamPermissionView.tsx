import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { AgentId, AgentSessionState, KubecodeApi, TeamMode } from '../api'
import { nativeSessionOptions } from '../agentSessionOptions'

export function NativeLeaderOptions({
  agentId,
  api,
  conversationId,
  mode,
  sessionState,
  setSessionState,
  t,
}: {
  agentId: AgentId
  api: KubecodeApi
  conversationId: string
  mode: TeamMode
  sessionState: AgentSessionState | null
  setSessionState: (state: AgentSessionState | null) => void
  t: Translator
}) {
  const native = nativeSessionOptions(sessionState)
  const permissionModeLocked = mode === 'yolo' && agentId !== 'opencode'
  const options = [
    ...(!permissionModeLocked && native.mode ? [native.mode] : []),
    ...native.configs,
  ]
  if (options.length === 0 && !permissionModeLocked) return null
  return (
    <FieldSet>
      <FieldLegend variant="label">{t('kubecode.teamLeaderConfiguration')}</FieldLegend>
      <FieldGroup className="gap-3">
        {permissionModeLocked && (
          <Field>
            <FieldTitle>{t('kubecode.teamYoloNativePermission')}</FieldTitle>
            <FieldDescription>{nativePermissionLabel(agentId, t)}</FieldDescription>
          </Field>
        )}
        {options.map((option) => {
          const label = option.kind === 'mode' ? t('kubecode.agentMode') : option.name
          const id = `team-leader-${option.kind}-${option.id}`
          if (option.type === 'boolean') {
            return (
              <Field key={`${option.kind}:${option.id}`} orientation="horizontal">
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <Switch
                  aria-label={label}
                  checked={option.currentValue}
                  id={id}
                  onCheckedChange={(value) => {
                    void api.setSessionConfig(conversationId, option.id, value)
                      .then(() => api.getSessionState(conversationId))
                      .then(setSessionState)
                  }}
                />
              </Field>
            )
          }
          return (
            <Field key={`${option.kind}:${option.id}`}>
              <FieldLabel htmlFor={id}>{label}</FieldLabel>
              <Select
                value={option.currentValue}
                onValueChange={(value) => {
                  const request = option.kind === 'mode'
                    ? api.setSessionMode(conversationId, value)
                    : api.setSessionConfig(conversationId, option.id, value)
                  void request.then(() => api.getSessionState(conversationId)).then(setSessionState)
                }}
              >
                <SelectTrigger aria-label={label} id={id}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {option.options.map((item) => (
                      <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )
        })}
      </FieldGroup>
    </FieldSet>
  )
}

function nativePermissionLabel(agentId: AgentId, t: Translator): string {
  const labels = {
    claude_code: 'kubecode.teamYoloPermissionClaude',
    codex: 'kubecode.teamYoloPermissionCodex',
    opencode: 'kubecode.teamYoloPermissionOpenCode',
  } as const satisfies Record<AgentId, TranslationKey>
  return t(labels[agentId])
}
