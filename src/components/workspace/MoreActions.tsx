import type { ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'

import { IconButton } from './IconButton'

export type MoreActionItem = {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  onSelect: () => void
}

export type MoreActionsProps = {
  /** Names what the actions are about, for example "More actions for this message". */
  label: string
  items: MoreActionItem[]
  align?: 'start' | 'end'
  /** `md` is the touch-sized control a row keeps on screen for a coarse pointer (ADR 0229 §7). */
  size?: 'sm' | 'md'
}

/**
 * A row's secondary actions behind one labelled control (ADR 0227), so a row
 * shows its primary action and nothing else until asked.
 */
export function MoreActions({ align = 'end', items, label, size = 'sm' }: MoreActionsProps) {
  if (items.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.more.Icon} />} label={label} size={size} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {items.map((item) => (
          <DropdownMenuItem disabled={item.disabled} key={item.id} onSelect={item.onSelect}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
