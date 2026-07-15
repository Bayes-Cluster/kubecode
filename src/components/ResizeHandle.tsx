import { useCallback, useEffect, useRef } from 'react'

interface ResizeHandleProps {
  direction?: 'horizontal' | 'vertical'
  onDoubleClick?: () => void
  onResize: (delta: number) => void
}

export function ResizeHandle({ direction = 'horizontal', onDoubleClick, onResize }: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null)
  const onResizeRef = useRef(onResize)
  const isDragging = useRef(false)
  const lastPosition = useRef(0)
  const pendingDelta = useRef(0)
  const rafId = useRef(0)

  useEffect(() => {
    onResizeRef.current = onResize
  }, [onResize])

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      lastPosition.current = direction === 'vertical' ? e.clientY : e.clientX
      pendingDelta.current = 0
      document.body.style.cursor = direction === 'vertical' ? 'row-resize' : 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [direction],
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const position = direction === 'vertical' ? e.clientY : e.clientX
      pendingDelta.current += position - lastPosition.current
      lastPosition.current = position

      if (!rafId.current) {
        rafId.current = requestAnimationFrame(() => {
          if (pendingDelta.current !== 0) {
            onResizeRef.current(pendingDelta.current)
            pendingDelta.current = 0
          }
          rafId.current = 0
        })
      }
    }

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        // Flush any pending delta
        if (rafId.current) {
          cancelAnimationFrame(rafId.current)
          rafId.current = 0
        }
        if (pendingDelta.current !== 0) {
          onResizeRef.current(pendingDelta.current)
          pendingDelta.current = 0
        }
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      if (rafId.current) cancelAnimationFrame(rafId.current)
    }
  }, [direction])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    handle.addEventListener('mousedown', handleMouseDown)
    return () => handle.removeEventListener('mousedown', handleMouseDown)
  }, [handleMouseDown])

  return (
    <div
      ref={handleRef}
      onDoubleClick={onDoubleClick}
      className={direction === 'vertical'
        ? 'relative z-30 -mt-1 h-1 shrink-0 self-stretch cursor-row-resize bg-transparent transition-colors hover:bg-[var(--border)]'
        : 'relative z-30 -ml-1 w-1 shrink-0 self-stretch cursor-col-resize bg-transparent transition-colors hover:bg-[var(--border)]'}
    />
  )
}
