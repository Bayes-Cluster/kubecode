import { ChevronDown, CircleAlert, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export type InlineNoticeProps = {
  level: 'warning' | 'error'
  /** The diagnostic, often long: one line until Details opens it. */
  message: string
  /** Names the Details toggle. */
  detailsLabel: string
  /** Names the close button; without `onClose` there is none. */
  closeLabel?: string
  onClose?: () => void
  /** Layout only: where the notice sits. */
  className?: string
}

const ICONS = { warning: TriangleAlert, error: CircleAlert } as const

/**
 * A diagnostic shown in place (ADR 0256 §5): the official Alert with the
 * official Collapsible, so a long message takes one line until Details opens
 * it, and a close Button when the caller can dismiss it. It is a composition
 * with no CSS of its own.
 */
export function InlineNotice({ className, closeLabel, detailsLabel, level, message, onClose }: InlineNoticeProps) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[level]
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Alert className={className} data-level={level} variant={level === 'error' ? 'destructive' : 'warning'}>
        <Icon />
        <AlertDescription className="flex min-w-0 items-start gap-1">
          {!open && <span className="min-w-0 flex-1 truncate select-text" title={message}>{message}</span>}
          <CollapsibleContent className="min-w-0 flex-1 whitespace-pre-wrap select-text [overflow-wrap:anywhere]">{message}</CollapsibleContent>
          <span className="flex shrink-0 items-center">
            <CollapsibleTrigger asChild>
              <Button aria-label={detailsLabel} size="icon-xs" variant="ghost">
                <ChevronDown className={cn(open && 'rotate-180')} />
              </Button>
            </CollapsibleTrigger>
            {onClose && (
              <Button aria-label={closeLabel} size="icon-xs" variant="ghost" onClick={onClose}>
                <X />
              </Button>
            )}
          </span>
        </AlertDescription>
      </Alert>
    </Collapsible>
  )
}
