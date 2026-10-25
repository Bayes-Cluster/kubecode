import type { ReactNode } from 'react'

import { Separator } from '@/components/ui/separator'
import { ViewHeader } from '@/components/workspace/ViewHeader'
import type { TranslationKey, Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import { Icon } from '../icons'
import { WORKSPACE_DESTINATION_ICONS } from '../icons/workspaceIcons'

/** The Workspace destinations, in navigation order, and what each is called. */
export const DESTINATION_TITLES = {
  general: 'kubecode.channel.general',
  board: 'kubecode.nav.board',
  resources: 'kubecode.nav.resources',
  'needs-you': 'kubecode.nav.needsYou',
  members: 'kubecode.nav.members',
} as const satisfies Record<string, TranslationKey>

export type Destination = keyof typeof DESTINATION_TITLES

const GLYPHS: Record<Destination, (typeof WORKSPACE_DESTINATION_ICONS)[keyof typeof WORKSPACE_DESTINATION_ICONS]> = {
  general: WORKSPACE_DESTINATION_ICONS.general,
  board: WORKSPACE_DESTINATION_ICONS.board,
  resources: WORKSPACE_DESTINATION_ICONS.resources,
  'needs-you': WORKSPACE_DESTINATION_ICONS.needsYou,
  members: WORKSPACE_DESTINATION_ICONS.members,
}

export type DestinationHeaderProps = {
  destination: Destination
  t: Translator
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
  /** Only General, when its channel has a name of its own. */
  title?: string
}

/**
 * The header every Workspace destination shares (#231): its glyph and name as
 * a level-2 heading, a description, facts and actions, over the official
 * Separator (ADR 0256). A destination is never "back" anywhere, so there is
 * no Back. The wrapper is the layout container; a parent that bleeds it to
 * its edges passes the margins as `className`.
 */
export function DestinationHeader({ actions, className, description, destination, meta, t, title }: DestinationHeaderProps) {
  return (
    <div className={cn('flex shrink-0 flex-col', className)}>
      <ViewHeader
        actions={actions}
        className="p-(--ws-space-3) md:px-(--ws-space-5) md:py-(--ws-space-3)"
        description={description}
        destination={destination}
        icon={<Icon role="navigation" source={GLYPHS[destination].Icon} />}
        level={2}
        meta={meta}
        title={title ?? t(DESTINATION_TITLES[destination])}
      />
      <Separator />
    </div>
  )
}
