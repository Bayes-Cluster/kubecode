import type { IlinkConnectionStatus, IlinkStatus } from '../api'

/** How often an in-progress login is polled; only login state is polled. */
export const WECHAT_LOGIN_POLL_MS = 1500

export const LOGIN_STATUSES: ReadonlySet<IlinkConnectionStatus> = new Set([
  'requesting_qr',
  'waiting_for_scan',
  'scanned',
  'verification_required',
  'redirecting',
])

export type WeChatAction = 'connect' | 'cancel' | 'verify' | 'reconnect' | 'disconnect'

/**
 * The only connection facts kept in browser state: categorical status, a
 * display name, and booleans. Account ids, tokens, QR identifiers, and
 * upstream errors never enter it.
 */
export type WeChatViewModel = {
  status: IlinkConnectionStatus
  displayName: string
  linked: boolean
  loginGeneration: number | null
  loginExpiresInMs: number | null
}

export function projectWeChatStatus(status: IlinkStatus): WeChatViewModel {
  return {
    status: status.status,
    displayName: status.display_name ?? '',
    linked: Boolean(status.account_id),
    loginGeneration: status.login_generation,
    loginExpiresInMs: status.login_expires_in_ms,
  }
}

