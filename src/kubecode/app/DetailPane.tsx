import { useEffect, useRef, type ReactNode } from 'react'

/**
 * The one on-demand detail area (ADR 0224). It takes focus when it opens, gives
 * it back to what opened it when it closes, and Escape closes it unless the
 * researcher is typing (an input keeps its own Escape).
 */
export function DetailPane({
  children,
  label,
  onClose,
}: {
  children: ReactNode
  label: string
  onClose: () => void
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
      className="kubecode-detail-pane"
      ref={pane}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
        const target = event.target as HTMLElement
        if (target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]')) return
        event.stopPropagation()
        onClose()
      }}
    >
      {children}
    </aside>
  )
}
