import { useCallback, useMemo, type ReactNode } from 'react'
import { toast } from 'sonner'

import { Toaster } from '@/components/ui/sonner'
import type { ThemeMode } from '@/lib/themeMode'

import { SystemMessageContext, type SystemMessage } from './systemMessages'

const TOASTS = {
  debug: toast,
  info: toast.info,
  success: toast.success,
  warning: toast.warning,
  error: toast.error,
} as const

/**
 * Application messages as official toasts (Sonner, ADR 0256): one host, the
 * newest three visible, a message published twice shown once, and every
 * message kept until it is closed.
 */
export function SystemMessageProvider({
  children,
  closeLabel,
  regionLabel,
  theme = 'system',
}: {
  children: ReactNode
  /** Names the close button of a toast. */
  closeLabel: string
  /** Names the toast region for assistive technology. */
  regionLabel: string
  theme?: ThemeMode
}) {
  const publish = useCallback((message: SystemMessage) => {
    TOASTS[message.level](message.message, {
      description: message.source,
      // Every message stays until it is closed, as the notices it replaces did.
      duration: Infinity,
      // The same message from the same source is one toast, not a stack.
      id: `${message.level}\u0000${message.source ?? ''}\u0000${message.message}`,
    })
  }, [])
  const api = useMemo(() => ({ publish }), [publish])

  return (
    <SystemMessageContext value={api}>
      {children}
      <Toaster closeButton containerAriaLabel={regionLabel} theme={theme} toastOptions={{ closeButtonAriaLabel: closeLabel }} visibleToasts={3} />
    </SystemMessageContext>
  )
}
