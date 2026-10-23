import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Check,
  CircleAlert,
  Copy,
  Info,
  RotateCw,
  TerminalSquare,
  X,
} from 'lucide-react'
import { trackEvent } from '@/lib/telemetry'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/workspace/StatusBadge'

import { MemberDefaultsPanel } from '../members/MemberDefaultsPanel'

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
  Conversation,
  Project,
  RuntimeStatus,
  WorkspaceEvent,
} from '../api'
import type {
  BrowserNotificationDelivery,
  BrowserNotificationPermission,
} from '../workspaceNotifications'
import type { Translator } from '@/lib/i18n'

import type { WeChatBinding } from './useWeChatBinding'
import { WeChatSettingsPanel } from './WeChatSettingsPanel'

export type SettingsSection = 'general' | 'notifications' | 'agents' | 'members' | 'wechat' | 'terminal' | 'editor'

export type SettingsDialogProps = {
  api: KubecodeApi
  agentPreferences: KubecodeAgentPreferences
  agents: AgentDescriptor[]
  agentsRefreshing: boolean
  appearance: KubecodeAppearance
  /** The selected Workspace, whose Members destination Agent defaults links to. */
  activeProjectId?: string | null
  /** Leaves Settings for the selected Workspace's Members destination. */
  onOpenWorkspaceMembers?: () => void
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
  wechatBinding?: WeChatBinding
  wechatConversations?: Conversation[]
  wechatProjects?: Project[]
  workspaceEvents?: WorkspaceEvent[]
}

export function SettingsDialog({
  api,
  agentPreferences,
  agents,
  agentsRefreshing,
  appearance,
  activeProjectId = null,
  onOpenWorkspaceMembers,
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
  wechatBinding,
  wechatConversations = NO_CONVERSATIONS,
  wechatProjects = NO_PROJECTS,
  workspaceEvents = NO_EVENTS,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(requestedSection)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const ids = useId()
  const wide = useWideLayout()

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

  const sectionList = (
    <TabsList
      aria-label={t('kubecode.settings')}
      className={wide ? 'h-auto w-52 shrink-0 justify-start self-stretch rounded-none p-3' : 'h-auto w-full shrink-0 justify-start overflow-x-auto rounded-none p-2'}
    >
      {SETTINGS_SECTIONS.map((item) => (
        <TabsTrigger className="flex-none" key={item} value={item}>
          {sectionTitle(item, false)}
        </TabsTrigger>
      ))}
    </TabsList>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={wide} className="flex h-[min(620px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[980px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[980px]">
        {/* On phones the title is visible and owns the close button, so the scrolling section strip below never runs under it. */}
        <DialogHeader className={wide ? 'sr-only' : 'flex-row items-center justify-between gap-2 border-b px-4 py-2 text-left'}>
          <DialogTitle>{t('kubecode.settings')}</DialogTitle>
          <DialogDescription className="sr-only">{t('kubecode.settingsDescription')}</DialogDescription>
          {!wide && (
            <DialogClose asChild>
              <Button aria-label={t('kubecode.vocab.command.close')} size="icon-sm" variant="ghost">
                <X />
              </Button>
            </DialogClose>
          )}
        </DialogHeader>
        <Tabs
          className="min-h-0 flex-1 gap-0"
          orientation={wide ? 'vertical' : 'horizontal'}
          value={section}
          onValueChange={(value) => setSection(value as SettingsSection)}
        >
          {sectionList}
          {SETTINGS_SECTIONS.map((item) => (
            <TabsContent className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-8" key={item} value={item}>
              <div className="flex flex-col gap-6">
                <h2 className="text-lg font-semibold">{sectionTitle(item, true)}</h2>
                {renderSection(item)}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  )

  function sectionTitle(item: SettingsSection, heading: boolean): string {
    if (item === 'general' && heading) return t('kubecode.appearance')
    if (item === 'members') return t('kubecode.settings.memberDefaults')
    return t(`kubecode.settings.${item}`)
  }

  function renderSection(item: SettingsSection) {
    if (item === 'general') {
      return (
        <FieldGroup>
          <SettingField description={t('kubecode.colorSchemeDescription')} id={`${ids}-color-scheme`} label={t('kubecode.colorScheme')}>
            {(control) => (
              <Select
                value={appearance.colorScheme}
                onValueChange={(value) => updateAppearance('colorScheme', value as KubecodeAppearance['colorScheme'])}
              >
                <SelectTrigger {...control} className="w-full sm:w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="system">{t('kubecode.theme.system')}</SelectItem>
                    <SelectItem value="light">{t('kubecode.theme.light')}</SelectItem>
                    <SelectItem value="dark">{t('kubecode.theme.dark')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </SettingField>
          <SettingField description={t('kubecode.themeDescription')} id={`${ids}-theme`} label={t('kubecode.theme')}>
            {(control) => (
              <Select value={appearance.theme} onValueChange={(value) => updateAppearance('theme', value as KubecodeTheme)}>
                <SelectTrigger {...control} className="w-full sm:w-52"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {KUBECODE_THEME_OPTIONS.map((theme) => (
                      <SelectItem key={theme} value={theme}>
                        <span
                          aria-hidden="true"
                          className="size-3.5 shrink-0 rounded-full border"
                          style={{ background: THEME_PREVIEWS[theme] }}
                        />
                        {t(`kubecode.theme.${theme}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </SettingField>
          <SettingField description={t('kubecode.uiFontDescription')} id={`${ids}-ui-font`} label={t('kubecode.uiFont')}>
            {(control) => (
              <Input
                {...control}
                className="w-full sm:max-w-80"
                value={appearance.uiFont}
                onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'uiFont' })}
                onChange={(event) => updateAppearance('uiFont', event.target.value)}
              />
            )}
          </SettingField>
          <SettingField description={t('kubecode.uiFontSizeDescription')} id={`${ids}-ui-font-size`} label={t('kubecode.uiFontSize')}>
            {(control) => (
              <Select
                value={String(appearance.uiFontSize)}
                onValueChange={(value) => {
                  updateAppearance('uiFontSize', Number(value))
                  trackEvent('kubecode_appearance_changed', { setting: 'uiFontSize', value: Number(value) })
                }}
              >
                <SelectTrigger {...control} className="w-full sm:w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Array.from({ length: 9 }, (_, index) => index + 12).map((size) => (
                      <SelectItem key={size} value={String(size)}>{size}px</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </SettingField>
          <SettingField description={t('kubecode.codeFontDescription')} id={`${ids}-code-font`} label={t('kubecode.codeFont')}>
            {(control) => (
              <Input
                {...control}
                className="w-full sm:max-w-80"
                value={appearance.codeFont}
                onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'codeFont' })}
                onChange={(event) => updateAppearance('codeFont', event.target.value)}
              />
            )}
          </SettingField>
          <SettingField description={t('kubecode.terminalFontDescription')} id={`${ids}-terminal-font`} label={t('kubecode.terminalFont')}>
            {(control) => (
              <Input
                {...control}
                className="w-full sm:max-w-80"
                value={appearance.terminalFont}
                onBlur={() => trackEvent('kubecode_appearance_changed', { setting: 'terminalFont' })}
                onChange={(event) => updateAppearance('terminalFont', event.target.value)}
              />
            )}
          </SettingField>
        </FieldGroup>
      )
    }
    if (item === 'notifications') {
      return (
        <FieldGroup>
          <SettingField
            description={t('kubecode.systemNotificationsDescription')}
            id={`${ids}-system-notifications`}
            label={t('kubecode.systemNotifications')}
          >
            {(control) => (
              <Select
                value={notifications.systemMode}
                onValueChange={(value) => {
                  onNotificationsChange({ ...notifications, systemMode: value as KubecodeNotifications['systemMode'] })
                  if (value !== 'off' && browserPermission === 'default') void onRequestNotificationPermission()
                  trackEvent('kubecode_notification_preference_changed', { setting: 'mode', value })
                }}
              >
                <SelectTrigger {...control} className="w-full sm:w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="always">{t('kubecode.notifications.always')}</SelectItem>
                    <SelectItem value="unfocused">{t('kubecode.notifications.unfocused')}</SelectItem>
                    <SelectItem value="off">{t('kubecode.notifications.off')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </SettingField>
          {(['completion', 'attention', 'error'] as const).map((category) => (
            <SettingField
              description={t(`kubecode.notifications.${category}Description`)}
              id={`${ids}-notify-${category}`}
              key={category}
              label={t(`kubecode.notifications.${category}`)}
            >
              {(control) => (
                <div className="flex items-center gap-3">
                  <Switch
                    {...control}
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
                      aria-label={t('kubecode.notificationSound', { category: t(`kubecode.notifications.${category}`) })}
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="system">{t('kubecode.notifications.systemSound')}</SelectItem>
                        <SelectItem value="none">{t('kubecode.notifications.noSound')}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </SettingField>
          ))}
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>{t('kubecode.notificationPermission')}</FieldTitle>
              <FieldDescription>{t(`kubecode.notifications.permission.${browserPermission}`)}</FieldDescription>
              {notificationTestStatus && (
                <StatusBadge className="w-fit" tone={notificationTestStatus === 'sent' ? 'ok' : 'danger'}>
                  <span role="status">{notificationTestMessage(t, notificationTestStatus, browserPermission)}</span>
                </StatusBadge>
              )}
            </FieldContent>
            <div className="flex flex-wrap gap-2">
              {browserPermission === 'default' && (
                <Button size="sm" variant="outline" onClick={() => void onRequestNotificationPermission()}>
                  {t('kubecode.enableNotifications')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void onTestNotification()}>
                {t('kubecode.testNotification')}
              </Button>
            </div>
          </Field>
        </FieldGroup>
      )
    }
    if (item === 'agents') {
      return (
        <FieldGroup>
          <SettingField
            description={t('kubecode.allowTeammateChatDescription')}
            id={`${ids}-teammate-chat`}
            label={t('kubecode.allowTeammateChat')}
          >
            {(control) => (
              <Switch
                {...control}
                checked={agentPreferences.allowTeammateChat}
                onCheckedChange={(allowTeammateChat) => {
                  onAgentPreferencesChange({ ...agentPreferences, allowTeammateChat })
                  trackEvent('kubecode_agent_preference_changed', {
                    setting: 'allowTeammateChat',
                    value: allowTeammateChat ? 'on' : 'off',
                  })
                }}
              />
            )}
          </SettingField>
          <FieldSet>
            <Field orientation="responsive">
              <FieldContent>
                <FieldLegend>{t('kubecode.agentReadiness')}</FieldLegend>
                <FieldDescription>{t('kubecode.agentReadinessDescription')}</FieldDescription>
              </FieldContent>
              <div className="flex flex-wrap gap-2">
                <Button disabled={agentsRefreshing} size="sm" variant="outline" onClick={() => void onRefreshAgents()}>
                  {agentsRefreshing ? <Spinner aria-hidden="true" data-icon="inline-start" /> : <RotateCw data-icon="inline-start" />}
                  {t('kubecode.checkAgain')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()}>
                  {diagnosticsCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                  {diagnosticsCopied ? t('kubecode.copied') : t('kubecode.copyDiagnostics')}
                </Button>
              </div>
            </Field>
            <Accordion type="multiple">
              {agents.map((agent) => (
                <AccordionItem key={agent.id} value={agent.id}>
                  <AccordionTrigger>
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <AiAgentIcon agent={agent.id} size={18} />
                      <span>{agentName(agent.id)}</span>
                      <StatusBadge tone={agent.available ? 'ok' : 'danger'}>
                        {agent.available ? agent.version ?? t('kubecode.ready') : t('kubecode.unavailable')}
                      </StatusBadge>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-3">
                    <ItemGroup className="gap-2">
                      <AgentDiagnosticRow
                        detail={agent.cli?.detail ?? agent.error}
                        label={t('kubecode.agentCli')}
                        status={agent.cli?.status ?? (agent.available ? 'ready' : 'missing')}
                        value={agent.cli?.version ?? agent.version ?? agent.executable}
                        t={t}
                      />
                      <AgentDiagnosticRow
                        detail={agent.adapter?.detail}
                        label={agent.adapter?.kind === 'native' ? t('kubecode.nativeAcp') : t('kubecode.acpAdapter')}
                        status={agent.adapter?.status ?? (agent.available ? 'ready' : 'missing')}
                        value={agent.adapter?.kind === 'native'
                          ? t('kubecode.builtIntoAgent')
                          : agent.adapter?.version ?? undefined}
                        t={t}
                      />
                    </ItemGroup>
                    <FieldDescription>{t('kubecode.authenticationCheckedOnSession')}</FieldDescription>
                    {agent.checked_at && (
                      <FieldDescription>
                        {t('kubecode.lastChecked', { time: new Date(agent.checked_at).toLocaleTimeString() })}
                      </FieldDescription>
                    )}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </FieldSet>
          <FieldSeparator />
          <RuntimeStatusPanel api={api} t={t} />
        </FieldGroup>
      )
    }
    if (item === 'members') {
      return (
        <FieldGroup>
          {/* App-wide defaults live here; a Workspace's own members live in its Members destination (#235). */}
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>{t('kubecode.members.current.title')}</FieldTitle>
              <FieldDescription>
                {activeProjectId ? t('kubecode.settings.memberDefaultsDescription') : t('kubecode.members.noProject')}
              </FieldDescription>
            </FieldContent>
            {activeProjectId && onOpenWorkspaceMembers && (
              <Button size="sm" variant="outline" onClick={onOpenWorkspaceMembers}>
                {t('kubecode.settings.openWorkspaceMembers')}
              </Button>
            )}
          </Field>
          <FieldSeparator />
          <MemberDefaultsPanel agents={agents} api={api} t={t} />
        </FieldGroup>
      )
    }
    if (item === 'wechat') {
      return (
        <WeChatSettingsPanel
          api={api}
          binding={wechatBinding}
          conversations={wechatConversations}
          projects={wechatProjects}
          t={t}
          workspaceEvents={workspaceEvents}
        />
      )
    }
    if (item === 'editor') {
      return (
        <FieldGroup>
          <SettingField description={t('kubecode.autoSaveDescription')} id={`${ids}-auto-save`} label={t('kubecode.autoSave')}>
            {(control) => (
              <Switch
                {...control}
                checked={editorPreferences.autoSave}
                onCheckedChange={(autoSave) => {
                  onEditorPreferencesChange({ ...editorPreferences, autoSave })
                  trackEvent('kubecode_editor_preference_changed', {
                    setting: 'autoSave',
                    value: autoSave ? 'on' : 'off',
                  })
                }}
              />
            )}
          </SettingField>
        </FieldGroup>
      )
    }
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><TerminalSquare /></EmptyMedia>
          <EmptyDescription>{t('kubecode.settingsComingSoon')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
}

const WIDE_QUERY = '(min-width: 768px)'

/** Settings list their sections beside the content on wide screens and above it on phones. */
function useWideLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined
      const query = window.matchMedia(WIDE_QUERY)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    },
    () => typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_QUERY).matches,
  )
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general', 'notifications', 'agents', 'members', 'wechat', 'terminal', 'editor',
]

type SettingControlProps = { id: string; 'aria-describedby': string }

/** One labelled, described setting: the official Field with its control. */
function SettingField({
  children,
  description,
  id,
  label,
}: {
  children: (control: SettingControlProps) => ReactNode
  description: string
  id: string
  label: string
}) {
  const descriptionId = `${id}-description`
  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      </FieldContent>
      <div className="flex min-w-0 items-center">{children({ id, 'aria-describedby': descriptionId })}</div>
    </Field>
  )
}

const NO_EVENTS: WorkspaceEvent[] = []
const NO_CONVERSATIONS: Conversation[] = []
const NO_PROJECTS: Project[] = []

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
    <FieldSet data-testid="runtime-status-panel">
      <Field orientation="responsive">
        <FieldContent>
          <FieldLegend>{t('kubecode.runtimeStatus')}</FieldLegend>
          <FieldDescription>{t('kubecode.runtimeStatusDescription')}</FieldDescription>
        </FieldContent>
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
          {busy && runtimeStatusAvailable ? <Spinner aria-hidden="true" data-icon="inline-start" /> : <RotateCw data-icon="inline-start" />}
          {t('kubecode.refresh')}
        </Button>
      </Field>
      {state.kind === 'loading' && (
        <FieldDescription role="status">{t('kubecode.runtimeStatusLoading')}</FieldDescription>
      )}
      {state.kind === 'error' && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{t('kubecode.runtimeStatusError')}</AlertDescription>
        </Alert>
      )}
      {state.kind === 'unavailable' && (
        <Alert role="status">
          <Info />
          <AlertDescription>{t('kubecode.runtimeStatusUnavailable')}</AlertDescription>
        </Alert>
      )}
      {state.kind === 'ready' && (
        <ItemGroup className="grid gap-2 sm:grid-cols-3">
          {([
            ['kubecode.runtimeActiveActors', state.status.active_actor_count],
            ['kubecode.runtimeIdleActors', state.status.idle_actor_count],
            ['kubecode.runtimeWarmActorLimit', state.status.warm_actor_limit],
          ] as const).map(([label, value]) => (
            <Item key={label} variant="outline">
              <ItemContent>
                <ItemDescription>{t(label)}</ItemDescription>
                <ItemTitle>{value}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </FieldSet>
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
    <Item size="sm" variant="muted">
      <ItemMedia variant="icon">{status === 'ready' ? <Check /> : <CircleAlert />}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>{value || (status === 'ready' ? t('kubecode.ready') : t('kubecode.unavailable'))}</ItemDescription>
        {detail && <code className="break-all text-xs">{detail}</code>}
      </ItemContent>
      <ItemActions>
        <StatusBadge tone={status === 'ready' ? 'ok' : 'danger'}>
          {status === 'ready' ? t('kubecode.ready') : t('kubecode.unavailable')}
        </StatusBadge>
      </ItemActions>
    </Item>
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
