/**
 * Moves focus to an element that is being revealed. An inspector entry under
 * another is `visibility: hidden`; when it is shown again, a control whose own
 * transition covers `visibility` (the official Button's `transition-all`)
 * stays hidden until that transition ends, and `focus()` does nothing. Try
 * now, and once more when the element's running transitions finish.
 */
export function focusWhenShown(element: HTMLElement) {
  element.focus({ preventScroll: true })
  if (document.activeElement === element) return
  const running = typeof element.getAnimations === 'function' ? element.getAnimations() : []
  if (running.length === 0) return
  void Promise.all(running.map((animation) => animation.finished)).then(
    () => {
      if (element.isConnected && document.activeElement !== element) element.focus({ preventScroll: true })
    },
    () => undefined,
  )
}
