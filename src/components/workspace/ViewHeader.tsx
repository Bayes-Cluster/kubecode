import type { ReactNode } from 'react'

import { Item, ItemActions, ItemContent, ItemDescription, ItemHeader, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

import { IconButton } from './IconButton'

export type ViewHeaderProps = {
  title: ReactNode
  /** A glyph before the title, usually the view's destination icon. */
  icon?: ReactNode
  description?: ReactNode
  /** Status badges and similar facts under the title. */
  meta?: ReactNode
  /** The view's own actions, at the end of the title row. */
  actions?: ReactNode
  /**
   * Only on a detail screen that replaced its list or another detail (a phone,
   * a detail opened from elsewhere, evidence opened from a Task in the
   * inspector, ADR 0228): returns there. A Workspace view is never "back"
   * anywhere.
   */
  back?: { label: string; onBack: () => void }
  /** Closes a detail shown beside its list. */
  close?: { label: string; onClose: () => void }
  /** Heading level; a page uses 1, views 2, details 3. */
  level?: 1 | 2 | 3
  /** Layout only: the padding its context gives the header. */
  className?: string
  /** The Workspace destination this header titles, for the shell's shared frame. */
  destination?: string
}

/**
 * The one header of every Workspace view and detail (ADR 0227): the official
 * Item with its header row (Back, glyph as the media, the heading as the
 * title, the view's actions, Close), facts as its content and the
 * description as its description (ADR 0256). The `header` element is the
 * context's layout container; the Item owns the appearance. It is kept as a
 * composition because the shell, the inspector and the destinations share
 * its Back/Close and heading-level contract.
 */
export function ViewHeader({
  actions,
  back,
  className,
  close,
  destination,
  description,
  icon,
  level = 2,
  meta,
  title,
}: ViewHeaderProps) {
  const Heading = (['h1', 'h2', 'h3'] as const)[level - 1]
  return (
    // The container takes only layout: a context passes its padding as utilities (ADR 0256).
    <header className={cn('pb-(--ws-space-2)', className)} data-destination={destination} data-level={level}>
      <Item className="flex-col items-stretch gap-1" size="compact">
        <ItemHeader className="flex-wrap justify-start">
          {back && (
            <IconButton
              icon={<Icon role="navigation" source={WORKSPACE_COMMAND_ICONS.back.Icon} />}
              label={back.label}
              size="md"
              onClick={back.onBack}
            />
          )}
          {icon && <ItemMedia aria-hidden="true">{icon}</ItemMedia>}
          <ItemTitle className="min-w-0 flex-1 basis-[14ch] [overflow-wrap:anywhere]">
            <Heading className="min-w-0 flex-1">{title}</Heading>
          </ItemTitle>
          {actions && <ItemActions className="ml-auto max-w-full flex-wrap justify-end gap-1">{actions}</ItemActions>}
          {close && (
            <IconButton
              icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.close.Icon} />}
              label={close.label}
              size="md"
              onClick={close.onClose}
            />
          )}
        </ItemHeader>
        {meta && <ItemContent className="flex-row flex-wrap items-center gap-2">{meta}</ItemContent>}
        {description && <ItemDescription className="max-w-(--ws-reading-width)">{description}</ItemDescription>}
      </Item>
    </header>
  )
}
