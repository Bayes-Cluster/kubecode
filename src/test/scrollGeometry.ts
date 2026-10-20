/**
 * Test support: jsdom lays nothing out, so a scroller never scrolls. This
 * gives every element a 100px window over 1000px of content and a scrollTop
 * that keeps what is set, for tests of scroll memory across remounts.
 */
export function stubScrollGeometry(): () => void {
  const tops = new WeakMap<Element, number>()
  const original = {
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  }
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return tops.get(this) ?? 0 },
    set(this: Element, value: number) { tops.set(this, Math.max(0, Math.min(value, 900))) },
  })
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 1000 })
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 100 })
  return () => {
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(Element.prototype, name, descriptor)
    }
  }
}

/** Waits for the next animation frame, where scroll positions are recorded. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}
