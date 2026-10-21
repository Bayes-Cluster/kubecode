import type { StatusTone } from '@/components/workspace/StatusBadge'

/** The official Badge variant for a Workspace status tone (ADR 0242); the words carry the meaning. */
export function statusBadgeVariant(tone: StatusTone): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (tone === 'danger') return 'destructive'
  if (tone === 'muted') return 'outline'
  return 'secondary'
}
