import {
  Select,
  SelectContent,
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
    <div className="kubecode-new-session-field">
      <span>{t('kubecode.teamLeaderConfiguration')}</span>
      <div className="kubecode-team-native-options">
        {permissionModeLocked && (
          <div className="kubecode-team-native-permission">
            <strong>{t('kubecode.teamYoloNativePermission')}</strong>
            <span>{nativePermissionLabel(agentId, t)}</span>
          </div>
        )}
        {options.map((option) => {
          const label = option.kind === 'mode' ? t('kubecode.agentMode') : option.name
          if (option.type === 'boolean') {
            return (
              <label key={`${option.kind}:${option.id}`}>
                <span>{label}</span>
                <Switch
                  aria-label={label}
                  checked={option.currentValue}
                  onCheckedChange={(value) => {
                    void api.setSessionConfig(conversationId, option.id, value)
                      .then(() => api.getSessionState(conversationId))
                      .then(setSessionState)
                  }}
                />
              </label>
            )
          }
          return (
            <label key={`${option.kind}:${option.id}`}>
              <span>{label}</span>
              <Select
                value={option.currentValue}
                onValueChange={(value) => {
                  const request = option.kind === 'mode'
                    ? api.setSessionMode(conversationId, value)
                    : api.setSessionConfig(conversationId, option.id, value)
                  void request.then(() => api.getSessionState(conversationId)).then(setSessionState)
                }}
              >
                <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {option.options.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )
        })}
      </div>
    </div>
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
