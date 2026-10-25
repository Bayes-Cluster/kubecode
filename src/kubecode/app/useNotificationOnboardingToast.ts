import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import type { Translator } from '@/lib/i18n'

export const NOTIFICATION_ONBOARDING_TOAST = 'notification-onboarding'

/**
 * Notification onboarding as one official toast (ADR 0256), offered while
 * `open`. Only a dismissal the researcher made — the close button or Not
 * now — records the choice through `onDismiss`; Enable goes through
 * `onEnable`, which records its own outcome; and a toast the app closes
 * itself (the conditions no longer hold) records nothing. Sonner calls a
 * toast's dismiss callback for every removal, so the hook tells them apart.
 */
export function useNotificationOnboardingToast({
  onDismiss,
  onEnable,
  open,
  t,
}: {
  open: boolean
  onEnable: () => void | Promise<unknown>
  onDismiss: () => void
  t: Translator
}) {
  // True while a removal is the app's or Enable's, so the dismiss callback stays quiet; false while the researcher may close it.
  const settled = useRef(false)
  useEffect(() => {
    if (!open) {
      settled.current = true
      toast.dismiss(NOTIFICATION_ONBOARDING_TOAST)
      return
    }
    settled.current = false
    const record = () => {
      if (settled.current) return
      settled.current = true
      onDismiss()
    }
    toast(t('kubecode.notificationOnboardingTitle'), {
      action: {
        label: t('kubecode.enableNotifications'),
        onClick: () => {
          settled.current = true
          void onEnable()
        },
      },
      // Sonner removes the toast after Not now without calling onDismiss, so Not now records the choice itself.
      cancel: { label: t('kubecode.notNow'), onClick: record },
      description: t('kubecode.notificationOnboardingDescription'),
      duration: Infinity,
      id: NOTIFICATION_ONBOARDING_TOAST,
      onDismiss: record,
    })
  }, [onDismiss, onEnable, open, t])
}
