import { describe, expect, it, vi } from 'vitest'

import { focusWhenShown } from './focusWhenShown'

describe('focusWhenShown', () => {
  it('focuses at once when the element can take focus', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    focusWhenShown(button)
    expect(document.activeElement).toBe(button)
    button.remove()
  })

  it('focuses again once a running transition (an inherited visibility reveal) has finished', async () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    const realFocus = button.focus.bind(button)
    let calls = 0
    button.focus = vi.fn((options?: FocusOptions) => {
      calls += 1
      // Still hidden by the transition on the first try.
      if (calls > 1) realFocus(options)
    })
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => { finish = resolve })
    button.getAnimations = () => [{ finished } as unknown as Animation]
    focusWhenShown(button)
    expect(document.activeElement).not.toBe(button)
    finish()
    await finished
    await Promise.resolve()
    expect(document.activeElement).toBe(button)
    button.remove()
  })
})
