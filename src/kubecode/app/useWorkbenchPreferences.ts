import { useCallback, useEffect, useState } from 'react'
import { trackEvent } from '@/lib/telemetry'

import {
  applyKubecodeAppearance,
  readKubecodeAppearance,
  writeKubecodeAppearance,
  type KubecodeAppearance,
} from '../appearancePreferences'
import {
  readAgentPreferences,
  writeAgentPreferences,
  type KubecodeAgentPreferences,
} from '../agentPreferences'
import {
  readEditorPreferences,
  writeEditorPreferences,
  type KubecodeEditorPreferences,
} from '../editorPreferences'
import {
  readKubecodeNotifications,
  writeKubecodeNotifications,
  type KubecodeNotifications,
} from '../notificationPreferences'
import {
  deliverBrowserNotification,
  ensureBrowserNotificationPermission,
  notificationPermission,
  type BrowserNotificationDelivery,
  type BrowserNotificationPermission,
} from '../workspaceNotifications'
import type { Translator } from '@/lib/i18n'

export function useWorkbenchPreferences(t: Translator) {
  const [appearance, setAppearance] = useState<KubecodeAppearance>(() => (
    readKubecodeAppearance(localStorage)
  ))
  const [editorPreferences, setEditorPreferences] = useState<KubecodeEditorPreferences>(() => (
    readEditorPreferences(localStorage)
  ))
  const [agentPreferences, setAgentPreferences] = useState<KubecodeAgentPreferences>(() => (
    readAgentPreferences(localStorage)
  ))
  const [notifications, setNotifications] = useState<KubecodeNotifications>(() => (
    readKubecodeNotifications(localStorage)
  ))
  const [notificationOnboardingSuppressed, setNotificationOnboardingSuppressed] = useState(false)
  const [browserPermission, setBrowserPermission] = useState<BrowserNotificationPermission>(() => (
    notificationPermission()
  ))
  const [notificationTestStatus, setNotificationTestStatus] = useState<BrowserNotificationDelivery['status'] | null>(null)

  useEffect(() => {
    applyKubecodeAppearance(document, appearance)
    writeKubecodeAppearance(localStorage, appearance)
    if (appearance.colorScheme !== 'system' || typeof window.matchMedia !== 'function') return
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystemTheme = () => applyKubecodeAppearance(document, appearance)
    systemTheme.addEventListener('change', applySystemTheme)
    return () => systemTheme.removeEventListener('change', applySystemTheme)
  }, [appearance])

  useEffect(() => {
    writeEditorPreferences(localStorage, editorPreferences)
  }, [editorPreferences])

  useEffect(() => {
    writeAgentPreferences(localStorage, agentPreferences)
  }, [agentPreferences])

  useEffect(() => {
    writeKubecodeNotifications(localStorage, notifications)
  }, [notifications])

  const requestNotificationPermission = useCallback(async () => {
    const permission = await ensureBrowserNotificationPermission()
    setBrowserPermission(permission)
    if (permission !== 'granted') {
      setNotificationTestStatus(permission === 'unsupported' ? 'unsupported' : 'permission_required')
    }
    setNotifications((current) => ({ ...current, onboardingDismissed: true }))
    setNotificationOnboardingSuppressed(true)
    trackEvent('kubecode_notification_permission_requested', { result: permission })
  }, [])

  const dismissNotificationOnboarding = useCallback(() => {
    setNotifications((current) => ({ ...current, onboardingDismissed: true }))
    setNotificationOnboardingSuppressed(true)
    trackEvent('kubecode_notification_onboarding_dismissed')
  }, [])

  const sendTestNotification = useCallback(async () => {
    const permission = await ensureBrowserNotificationPermission()
    setBrowserPermission(permission)
    if (permission !== 'granted') {
      setNotificationTestStatus(permission === 'unsupported' ? 'unsupported' : 'permission_required')
      return
    }
    const delivery = deliverBrowserNotification(t('kubecode.notificationTestTitle'), {
      body: t('kubecode.notificationTestBody'),
      silent: notifications.sound.completion === 'none',
      tag: 'kubecode:test',
    })
    setNotificationTestStatus(delivery.status)
    trackEvent('kubecode_notification_tested', { result: delivery.status })
  }, [notifications.sound.completion, t])

  return {
    agentPreferences,
    appearance,
    browserPermission,
    dismissNotificationOnboarding,
    editorPreferences,
    notificationOnboardingSuppressed,
    notificationTestStatus,
    notifications,
    requestNotificationPermission,
    sendTestNotification,
    setAgentPreferences,
    setAppearance,
    setEditorPreferences,
    setNotifications,
  }
}
