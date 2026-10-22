import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import type { StatusTone } from '@/components/workspace/StatusBadge'

/**
 * The official Badge with the Workspace's status tones (ADR 0243): the text
 * carries the meaning, the tone (`data-tone`, styled in kubecode.css) only
 * adds emphasis.
 */
export function ToneBadge({ children, title, tone = 'muted' }: { children: ReactNode; title?: string; tone?: StatusTone }) {
  return (
    <Badge className="kubecode-tone-badge" data-tone={tone} title={title} variant="secondary">
      {children}
    </Badge>
  )
}
