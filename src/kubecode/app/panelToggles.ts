import { trackEvent } from '@/lib/telemetry'

export function togglePanel(panel: 'sessions' | 'terminal' | 'context', open: boolean): boolean {
  const nextOpen = !open
  trackEvent('kubecode_panel_toggled', { next_state: nextOpen ? 'open' : 'closed', panel })
  return nextOpen
}
