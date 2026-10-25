/**
 * How a status reads at a glance. The words always carry the meaning; the
 * tone only picks an official Badge variant, so it is never the only signal
 * (ADR 0247, ADR 0256).
 */
export type StatusTone = 'ok' | 'info' | 'warn' | 'danger' | 'muted'

export type StatusVariant = 'success' | 'info' | 'warning' | 'destructive' | 'secondary'

const VARIANTS = {
  ok: 'success',
  info: 'info',
  warn: 'warning',
  danger: 'destructive',
  muted: 'secondary',
} as const satisfies Record<StatusTone, StatusVariant>

/** The Badge variant a tone chooses. */
export function statusToneVariant(tone: StatusTone = 'muted'): StatusVariant {
  return VARIANTS[tone]
}
