import type { ComponentProps, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export type IconButtonProps = Omit<ComponentProps<typeof Button>, 'children' | 'size' | 'aria-label'> & {
  /** What it does. It is the accessible name and the tooltip; an icon alone is never a name. */
  label: string
  icon: ReactNode
  /** Shown in the tooltip beside the label. */
  shortcut?: string
  /** An action is in flight: the button ignores clicks, stays focusable, and announces it. */
  busy?: boolean
  /** `sm` is the compact control used inside dense rows. */
  size?: 'sm' | 'md'
}

/**
 * A labelled icon-only control: the official Button in an icon size inside
 * the official Tooltip, its shortcut a Kbd, its busy state the official
 * Spinner (ADR 0255). It is a pass-through with no appearance of its own; it
 * only carries the contract that the label is required and that a busy
 * button keeps focus.
 */
export function IconButton({
  busy = false,
  icon,
  label,
  onClick,
  shortcut,
  size = 'sm',
  type = 'button',
  variant = 'ghost',
  ...props
}: IconButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            aria-label={label}
            size={size === 'sm' ? 'icon-xs' : 'icon-sm'}
            type={type}
            variant={variant}
            {...props}
            // A busy button keeps focus (it is not `disabled`), and ignores clicks.
            onClick={busy ? undefined : onClick}
          >
            {busy ? <Spinner aria-hidden="true" /> : icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {label}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
