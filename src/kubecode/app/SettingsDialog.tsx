import { useEffect, useState, type CSSProperties } from 'react'
import { ArrowClockwise, Check, Copy, WarningCircle } from '@phosphor-icons/react'
import { trackEvent } from '@/lib/telemetry'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import type { KubecodeAgentPreferences } from '../agentPreferences'
import type { KubecodeAppearance, KubecodeTheme } from '../appearancePreferences'
import { KUBECODE_THEME_OPTIONS } from '../appearancePreferences'
import type { KubecodeEditorPreferences } from '../editorPreferences'
import type {
  KubecodeNotifications,
  NotificationCategory,
} from '../notificationPreferences'
import type {
  AgentDescriptor,
  AgentId,
  KubecodeApi,
  RuntimeStatus,
} from '../api'
import type {
  BrowserNotificationDelivery,
  BrowserNotificationPermission,
} from '../workspaceNotifications'
import type { Translator } from './translator'

export type SettingsSection = 'general' | 'notifications' | 'agents' | 'terminal' | 'editor'

export type SettingsDialogProps = {
  api: KubecodeApi
  agentPreferences: KubecodeAgentPreferences
  agents: AgentDescriptor[]
  agentsRefreshing: boolean
  appearance: KubecodeAppearance
  editorPreferences: KubecodeEditorPreferences
  notifications: KubecodeNotifications
  notificationPermission: BrowserNotificationPermission
  notificationTestStatus: BrowserNotificationDelivery['status'] | null
  open: boolean
  requestedSection: SettingsSection
  onAppearanceChange: (appearance: KubecodeAppearance) => void
  onAgentPreferencesChange: (preferences: KubecodeAgentPreferences) => void
  onEditorPreferencesChange: (preferences: KubecodeEditorPreferences) => void
  onNotificationsChange: (notifications: KubecodeNotifications) => void
  onOpenChange: (open: boolean) => void
  onRequestNotificationPermission: () => Promise<void>
  onRefreshAgents: () => Promise<void>
  onTestNotification: () => Promise<void>
  t: Translator
}

export function SettingsDialog({
  api,
  agentPreferences,
  agents,
  agentsRefreshing,
  appearance,
  editorPreferences,
  notifications,
  notificationPermission: browserPermission,
  notificationTestStatus,
  open,
  requestedSection,
  onAppearanceChange,
  onAgentPreferencesChange,
  onEditorPreferencesChange,
  onNotificationsChange,
  onOpenChange,
  onRequestNotificationPermission,
  onRefreshAgents,
  onTestNotification,
  t,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(requestedSection)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)

  const copyDiagnostics = async () => {
    const report = {
      schema_version: 1,
      agents: agents.map((agent) => ({
        id: agent.id,
        readiness: agent.readiness ?? (agent.available ? 'ready' : 'unavailable'),
        cli_version: agent.cli?.version ?? agent.version,
        cli_source: agent.cli?.source ?? null,
        cli_error_code: agent.cli?.error_code ?? null,
        adapter_kind: agent.adapter?.kind ?? (agent.id === 'opencode' ? 'native' : 'bundled'),
        adapter_version: agent.adapter?.version ?? null,
        adapter_error_code: agent.adapter?.error_code ?? null,
        checked_at: agent.checked_at ?? null,
      })),
    }
    await navigator.clipboard?.writeText(JSON.stringify(report, null, 2))
    setDiagnosticsCopied(true)
    window.setTimeout(() => setDiagnosticsCopied(false), 1800)
  }

  const updateAppearance = <Key extends keyof KubecodeAppearance>(
    key: Key,
    value: KubecodeAppearance[Key],
  ) => {
    onAppearanceChange({ ...appearance, [key]: value })
    if (key === 'colorScheme' || key === 'theme') {
      trackEvent('kubecode_appearance_changed', { setting: key, value })
    }
  }

  const updateNotificationCategory = (
    category: NotificationCategory,
    enabled: boolean,
  ) => {
    onNotificationsChange({
      ...notifications,
      enabled: { ...notifications.enabled, [category]: enabled },
    })
    trackEvent('kubecode_notification_preference_changed', { category, setting: 'enabled' })
  }

  const updateNotificationSound = (
    category: NotificationCategory,
    sound: KubecodeNotifications['sound'][NotificationCategory],
  ) => {
    onNotificationsChange({
      ...notifications,
      sound: { ...notifications.sound, [category]: sound },
    })
    trackEvent('kubecode_notification_preference_changed', { category, setting: 'sound', value: sound })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="kubecode-settings-dialog">
        <DialogHeader className="sr-only">
          <DialogTitle>{t('kubecode.settings')}</DialogTitle>
          <DialogDescription>{t('kubecode.settingsDescription')}</DialogDescription>
        </DialogHeader>
        <aside className="kubecode-settings-nav">
          <strong>{t('kubecode.settings')}</strong>
          {(['general', 'notifications', 'agents', 'terminal', 'editor'] as const).map((item) => (
            <Button key={item} variant={section === item ? 'secondary' : 'ghost'} onClick={() => setSection(item)}>
              {t(`kubecode.settings.${item}`)}
            </Button>
          ))}
        </aside>
        <section className="kubecode-settings-content">
          <h2>{section === 'general' ? t('kubecode.appearance') : t(`kubecode.settings.${section}`)}</h2>
          {section === 'general' && (
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.colorScheme')}</strong><span>{t('kubecode.colorSchemeDescription')}</span></div>
                <Select
                  value={appearance.colorScheme}
                  onValueChange={(value) => updateAppearance('colorScheme', value as KubecodeAppearance['colorScheme'])}
                >
                  <SelectTrigger aria-label={t('kubecode.colorScheme')} className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">{t('kubecode.theme.system')}</SelectItem>
                    <SelectItem value="light">{t('kubecode.theme.light')}</SelectItem>
                    <SelectItem value="dark">{t('kubecode.theme.dark')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.theme')}</strong><span>{t('kubecode.themeDescription')}</span></div>
                <Select
                  value={appearance.theme}
                  onValueChange={(value) => updateAppearance('theme', value as KubecodeTheme)}
                >
                  <SelectTrigger aria-label={t('kubecode.theme')} className="w-52"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {KUBECODE_THEME_OPTIONS.map((theme) => (
                      <SelectItem key={theme} value={theme}>
                        <span
                          aria-hidden="true"
                          className="kubecode-theme-swatch"
                          style={{ '--theme-preview': THEME_PREVIEWS[theme] } as CSSProperties}
                        />
                        {t(`kubecode.theme.${theme}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.uiFont')}</strong><span>{t('kubecode.uiFontDescription')}</span></div>
                <Input
                  aria-label={t('kubecode.uiFont')}
                  className="kubecode-font-input"
                  value={appearance.uiFont}
                  onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'uiFont' })}
                  onChange={(event) => updateAppearance('uiFont', event.target.value)}
                />
              </div>
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.uiFontSize')}</strong>
                  <span>{t('kubecode.uiFontSizeDescription')}</span>
                </div>
                <Select
                  value={String(appearance.uiFontSize)}
                  onValueChange={(value) => {
                    updateAppearance('uiFontSize', Number(value))
                    trackEvent('kubecode_appearance_changed', {
                      setting: 'uiFontSize',
                      value: Number(value),
                    })
                  }}
                >
                  <SelectTrigger aria-label={t('kubecode.uiFontSize')} className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 9 }, (_, index) => index + 12).map((size) => (
                      <SelectItem key={size} value={String(size)}>{size}px</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.codeFont')}</strong><span>{t('kubecode.codeFontDescription')}</span></div>
                <Input
                  aria-label={t('kubecode.codeFont')}
                  className="kubecode-font-input kubecode-font-input-mono"
                  value={appearance.codeFont}
                  onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'codeFont' })}
                  onChange={(event) => updateAppearance('codeFont', event.target.value)}
                />
              </div>
              <div className="kubecode-setting-row">
                <div><strong>{t('kubecode.terminalFont')}</strong><span>{t('kubecode.terminalFontDescription')}</span></div>
                <Input
                  aria-label={t('kubecode.terminalFont')}
                  className="kubecode-font-input kubecode-font-input-mono"
                  value={appearance.terminalFont}
                  onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'terminalFont' })}
                  onChange={(event) => updateAppearance('terminalFont', event.target.value)}
                />
              </div>
            </div>
          )}
          {section === 'notifications' && (
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.systemNotifications')}</strong>
                  <span>{t('kubecode.systemNotificationsDescription')}</span>
                </div>
                <Select
                  value={notifications.systemMode}
                  onValueChange={(value) => {
                    onNotificationsChange({
                      ...notifications,
                      systemMode: value as KubecodeNotifications['systemMode'],
                    })
                    if (value !== 'off' && browserPermission === 'default') {
                      void onRequestNotificationPermission()
                    }
                    trackEvent('kubecode_notification_preference_changed', { setting: 'mode', value })
                  }}
                >
                  <SelectTrigger aria-label={t('kubecode.systemNotifications')} className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">{t('kubecode.notifications.always')}</SelectItem>
                    <SelectItem value="unfocused">{t('kubecode.notifications.unfocused')}</SelectItem>
                    <SelectItem value="off">{t('kubecode.notifications.off')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(['completion', 'attention', 'error'] as const).map((category) => (
                <div className="kubecode-setting-row kubecode-notification-category" key={category}>
                  <div>
                    <strong>{t(`kubecode.notifications.${category}`)}</strong>
                    <span>{t(`kubecode.notifications.${category}Description`)}</span>
                  </div>
                  <div className="kubecode-notification-controls">
                    <Switch
                      aria-label={t(`kubecode.notifications.${category}`)}
                      checked={notifications.enabled[category]}
                      onCheckedChange={(checked) => updateNotificationCategory(category, checked)}
                    />
                    <Select
                      value={notifications.sound[category]}
                      onValueChange={(value) => updateNotificationSound(
                        category,
                        value as KubecodeNotifications['sound'][NotificationCategory],
                      )}
                    >
                      <SelectTrigger
                        aria-label={t('kubecode.notificationSound', {
                          category: t(`kubecode.notifications.${category}`),
                        })}
                        className="w-36"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">{t('kubecode.notifications.systemSound')}</SelectItem>
                        <SelectItem value="none">{t('kubecode.notifications.noSound')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.notificationPermission')}</strong>
                  <span>{t(`kubecode.notifications.permission.${browserPermission}`)}</span>
                  {notificationTestStatus && (
                    <span className="kubecode-notification-test-result" data-status={notificationTestStatus} role="status">
                      {notificationTestMessage(t, notificationTestStatus, browserPermission)}
                    </span>
                  )}
                </div>
                <div className="kubecode-notification-controls">
                  {browserPermission === 'default' && (
                    <Button size="sm" variant="outline" onClick={() => void onRequestNotificationPermission()}>
                      {t('kubecode.enableNotifications')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onTestNotification()}
                  >
                    {t('kubecode.testNotification')}
                  </Button>
                </div>
              </div>
            </div>
          )}
          {section === 'agents' && (
            <>
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.allowTeammateChat')}</strong>
                  <span>{t('kubecode.allowTeammateChatDescription')}</span>
                </div>
                <Switch
                  aria-label={t('kubecode.allowTeammateChat')}
                  checked={agentPreferences.allowTeammateChat}
                  onCheckedChange={(allowTeammateChat) => {
                    onAgentPreferencesChange({ ...agentPreferences, allowTeammateChat })
                    trackEvent('kubecode_agent_preference_changed', {
                      setting: 'allowTeammateChat',
                      value: allowTeammateChat ? 'on' : 'off',
                    })
                  }}
                />
              </div>
              <div className="kubecode-setting-row kubecode-agent-doctor-toolbar">
                <div>
                  <strong>{t('kubecode.agentReadiness')}</strong>
                  <span>{t('kubecode.agentReadinessDescription')}</span>
                </div>
                <div className="kubecode-agent-doctor-actions">
                  <Button
                    disabled={agentsRefreshing}
                    size="sm"
                    variant="outline"
                    onClick={() => void onRefreshAgents()}
                  >
                    <ArrowClockwise className={agentsRefreshing ? 'animate-spin' : undefined} />
                    {t('kubecode.checkAgain')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()}>
                    {diagnosticsCopied ? <Check /> : <Copy />}
                    {diagnosticsCopied ? t('kubecode.copied') : t('kubecode.copyDiagnostics')}
                  </Button>
                </div>
              </div>
              {agents.map((agent) => (
                <details className="kubecode-agent-diagnostic" key={agent.id}>
                  <summary>
                    <span>
                      <AiAgentIcon agent={agent.id} size={18} />
                      <strong>{agentName(agent.id)}</strong>
                    </span>
                    <span data-available={agent.available}>
                      {agent.available ? agent.version ?? t('kubecode.ready') : t('kubecode.unavailable')}
                    </span>
                  </summary>
                  <div className="kubecode-agent-diagnostic-body">
                    <AgentDiagnosticRow
                      detail={agent.cli?.detail ?? agent.error}
                      label={t('kubecode.agentCli')}
                      status={agent.cli?.status ?? (agent.available ? 'ready' : 'missing')}
                      value={agent.cli?.version ?? agent.version ?? agent.executable}
                      t={t}
                    />
                    <AgentDiagnosticRow
                      detail={agent.adapter?.detail}
                      label={agent.adapter?.kind === 'native'
                        ? t('kubecode.nativeAcp')
                        : t('kubecode.acpAdapter')}
                      status={agent.adapter?.status ?? (agent.available ? 'ready' : 'missing')}
                      value={agent.adapter?.kind === 'native'
                        ? t('kubecode.builtIntoAgent')
                        : agent.adapter?.version ?? undefined}
                      t={t}
                    />
                    <div className="kubecode-agent-auth-note">
                      {t('kubecode.authenticationCheckedOnSession')}
                    </div>
                    {agent.checked_at && (
                      <small>{t('kubecode.lastChecked', {
                        time: new Date(agent.checked_at).toLocaleTimeString(),
                      })}</small>
                    )}
                  </div>
                </details>
              ))}
            </div>
            <h3 className="kubecode-settings-section-heading">{t('kubecode.runtime')}</h3>
            <RuntimeStatusPanel api={api} t={t} />
            </>
          )}
          {section === 'editor' && (
            <div className="kubecode-settings-group">
              <div className="kubecode-setting-row">
                <div>
                  <strong>{t('kubecode.autoSave')}</strong>
                  <span>{t('kubecode.autoSaveDescription')}</span>
                </div>
                <Switch
                  aria-label={t('kubecode.autoSave')}
                  checked={editorPreferences.autoSave}
                  onCheckedChange={(autoSave) => {
                    onEditorPreferencesChange({ ...editorPreferences, autoSave })
                    trackEvent('kubecode_editor_preference_changed', {
                      setting: 'autoSave',
                      value: autoSave ? 'on' : 'off',
                    })
                  }}
                />
              </div>
            </div>
          )}
          {section === 'terminal' && (
            <div className="kubecode-settings-placeholder">{t('kubecode.settingsComingSoon')}</div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}

type RuntimeStatusViewModel = {
  active_actor_count: number
  idle_actor_count: number
  warm_actor_limit: number
  workspace_event_delivery_available: boolean
}

function projectRuntimeStatus(status: RuntimeStatus): RuntimeStatusViewModel {
  return {
    active_actor_count: status.active_actor_count,
    idle_actor_count: status.idle_actor_count,
    warm_actor_limit: status.warm_actor_limit,
    workspace_event_delivery_available: status.workspace_event_delivery_available,
  }
}

function RuntimeStatusPanel({ api, t }: { api: KubecodeApi; t: Translator }) {
  const runtimeStatusAvailable = typeof api.runtimeStatus === 'function'
  const [request, setRequest] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; status: RuntimeStatusViewModel }
    | { kind: 'error' }
    | { kind: 'unavailable' }
  >(runtimeStatusAvailable ? { kind: 'loading' } : { kind: 'unavailable' })

  useEffect(() => {
    let current = true
    if (!runtimeStatusAvailable) return () => { current = false }
    void api.runtimeStatus().then((response) => {
      if (!current) return
      const status = projectRuntimeStatus(response)
      setState(status.workspace_event_delivery_available
        ? { kind: 'ready', status }
        : { kind: 'unavailable' })
    }).catch(() => {
      if (current) setState({ kind: 'error' })
    }).finally(() => {
      if (current) setRefreshing(false)
    })
    return () => { current = false }
  }, [api, request, runtimeStatusAvailable])

  const busy = state.kind === 'loading' || refreshing
  return (
    <div className="kubecode-settings-group" data-testid="runtime-status-panel">
      <div className="kubecode-setting-row kubecode-runtime-toolbar">
        <div>
          <strong>{t('kubecode.runtimeStatus')}</strong>
          <span>{t('kubecode.runtimeStatusDescription')}</span>
          {state.kind === 'loading' && <span role="status">{t('kubecode.runtimeStatusLoading')}</span>}
          {state.kind === 'error' && <span role="alert">{t('kubecode.runtimeStatusError')}</span>}
          {state.kind === 'unavailable' && <span role="status">{t('kubecode.runtimeStatusUnavailable')}</span>}
        </div>
        <Button
          aria-label={t('kubecode.runtimeRefresh')}
          disabled={busy || !runtimeStatusAvailable}
          size="sm"
          variant="outline"
          onClick={() => {
            setRefreshing(true)
            setRequest((value) => value + 1)
          }}
        >
          <ArrowClockwise className={busy ? 'animate-spin' : undefined} />
          {t('kubecode.refresh')}
        </Button>
      </div>
      {state.kind === 'ready' && (
        <dl className="kubecode-runtime-counts">
          <div><dt>{t('kubecode.runtimeActiveActors')}</dt><dd>{state.status.active_actor_count}</dd></div>
          <div><dt>{t('kubecode.runtimeIdleActors')}</dt><dd>{state.status.idle_actor_count}</dd></div>
          <div><dt>{t('kubecode.runtimeWarmActorLimit')}</dt><dd>{state.status.warm_actor_limit}</dd></div>
        </dl>
      )}
    </div>
  )
}

function AgentDiagnosticRow({
  detail,
  label,
  status,
  t,
  value,
}: {
  detail?: string | null
  label: string
  status: 'ready' | 'missing' | 'error'
  t: Translator
  value?: string | null
}) {
  return (
    <div className="kubecode-agent-diagnostic-row">
      <span data-status={status}>{status === 'ready' ? <Check /> : <WarningCircle />}</span>
      <div>
        <strong>{label}</strong>
        <small>{value || (status === 'ready' ? t('kubecode.ready') : t('kubecode.unavailable'))}</small>
        {detail && <code>{detail}</code>}
      </div>
    </div>
  )
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}

function notificationTestMessage(
  t: Translator,
  status: BrowserNotificationDelivery['status'],
  permission: BrowserNotificationPermission,
): string {
  if (status === 'sent') return t('kubecode.notificationTestTitle')
  if (status === 'failed') return t('kubecode.error')
  const effectivePermission = status === 'unsupported' ? 'unsupported' : permission
  return t(`kubecode.notifications.permission.${effectivePermission}`)
}

const THEME_PREVIEWS: Record<KubecodeTheme, string> = {
  opencode: 'linear-gradient(135deg, #111218 0 48%, #7c72e8 48% 72%, #f3f2fa 72%)',
  system: 'linear-gradient(135deg, #ffffff 0 48%, #8b8b8b 48% 52%, #1f1e1b 52%)',
  tokyonight: 'linear-gradient(135deg, #1a1b26 0 58%, #7aa2f7 58%)',
  everforest: 'linear-gradient(135deg, #2d353b 0 58%, #83c092 58%)',
  ayu: 'linear-gradient(135deg, #0b0e14 0 58%, #ffb454 58%)',
  catppuccin: 'linear-gradient(135deg, #1e1e2e 0 58%, #cba6f7 58%)',
  'catppuccin-macchiato': 'linear-gradient(135deg, #24273a 0 58%, #8aadf4 58%)',
  gruvbox: 'linear-gradient(135deg, #282828 0 58%, #d79921 58%)',
  kanagawa: 'linear-gradient(135deg, #1f1f28 0 58%, #7e9cd8 58%)',
  nord: 'linear-gradient(135deg, #2e3440 0 58%, #88c0d0 58%)',
  matrix: 'linear-gradient(135deg, #050b07 0 58%, #00c853 58%)',
  'one-dark': 'linear-gradient(135deg, #282c34 0 58%, #61afef 58%)',
}
