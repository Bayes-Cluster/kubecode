import { Loader2 } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { ActionTooltip } from '@/components/ui/action-tooltip'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type IconButtonProps = Omit<ComponentProps<typeof Button>, 'children' | 'size' | 'aria-label'> & {
  /** What it does. It is the accessible name and the tooltip; an icon alone is never a name. */
  label: string
  icon: ReactNode
  /** Shown in the tooltip beside the label. */
  shortcut?: string
  /** An action is in flight: the button is disabled and announces it. */
  busy?: boolean
  /** `sm` is the compact control used inside dense rows; both keep a touch-sized hit area. */
  size?: 'sm' | 'md'
}

/**
 * The one icon-only control of Workspace views: a labelled ghost button with a
 * tooltip, a consistent size, visible focus, and a touch-sized hit area. Use it
 * instead of a bare `Button` with an icon so every view looks and speaks alike.
 */
export function IconButton({
  busy = false,
  className,
  disabled,
  icon,
  label,
  shortcut,
  size = 'sm',
  type = 'button',
  variant = 'ghost',
  ...props
}: IconButtonProps) {
  return (
    <TooltipProvider>
      <ActionTooltip copy={{ label, shortcut }}>
        <Button
          aria-busy={busy || undefined}
          aria-label={label}
          className={cn('kubecode-icon-button', className)}
          data-size={size}
          disabled={disabled || busy}
          size={size === 'sm' ? 'icon-xs' : 'icon-sm'}
          type={type}
          variant={variant}
          {...props}
        >
          {busy ? <Loader2 aria-hidden className="animate-spin" size={size === 'sm' ? 14 : 16} /> : icon}
        </Button>
      </ActionTooltip>
    </TooltipProvider>
  )
}
