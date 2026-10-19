import type { ReactNode } from 'react'

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
   * Only on a detail screen that replaced its list (a phone, a detail opened
   * from elsewhere): returns there. A Workspace view is never "back" anywhere.
   */
  back?: { label: string; onBack: () => void }
  /** Closes a detail shown beside its list. */
  close?: { label: string; onClose: () => void }
  /** Heading level; a page uses 1, views 2, details 3. */
  level?: 1 | 2 | 3
  className?: string
}

/** The one header of every Workspace view and detail (ADR 0227). */
export function ViewHeader({
  actions,
  back,
  className,
  close,
  description,
  icon,
  level = 2,
  meta,
  title,
}: ViewHeaderProps) {
  const Heading = (['h1', 'h2', 'h3'] as const)[level - 1]
  return (
    <header className={cn('kubecode-view-header', className)} data-level={level}>
      <div className="kubecode-view-header-row">
        {back && (
          <IconButton
            icon={<Icon role="navigation" source={WORKSPACE_COMMAND_ICONS.back.Icon} />}
            label={back.label}
            size="md"
            onClick={back.onBack}
          />
        )}
        {icon && <span aria-hidden="true" className="kubecode-view-header-icon">{icon}</span>}
        <Heading className="kubecode-view-header-title">{title}</Heading>
        {actions && <div className="kubecode-view-header-actions">{actions}</div>}
        {close && (
          <IconButton
            icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.close.Icon} />}
            label={close.label}
            size="md"
            onClick={close.onClose}
          />
        )}
      </div>
      {meta && <div className="kubecode-view-header-meta">{meta}</div>}
      {description && <p className="kubecode-view-header-description">{description}</p>}
    </header>
  )
}
