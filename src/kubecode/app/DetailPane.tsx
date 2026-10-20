import { useEffect, useRef, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The aside of an on-demand detail (ADR 0224, ADR 0228). It takes focus when
 * it opens and gives it back to what opened it when it closes. Escape is
 * handed to `onEscape` (the inspector pops one level) unless the researcher is
 * typing, composing, or choosing in a list: those keep their own Escape.
 */
export function DetailPane({
  children,
  className,
  label,
  onEscape,
}: {
  children: ReactNode
  className?: string
  label: string
  onEscape: () => void
}) {
  const pane = useRef<HTMLElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    pane.current?.focus({ preventScroll: true })
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true })
    }
  }, [])

  return (
    <aside
      aria-label={label}
      className={cn('kubecode-detail-pane', className)}
      ref={pane}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
        const target = event.target as HTMLElement
        if (target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]')) return
        event.stopPropagation()
        onEscape()
      }}
    >
      {children}
    </aside>
  )
}
