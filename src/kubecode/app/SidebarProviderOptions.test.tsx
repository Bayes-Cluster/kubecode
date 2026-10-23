import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

function ctrlB() {
  const event = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('SidebarProvider options the shell relies on', () => {
  it('leaves Ctrl+B to the terminal, composer and IME when the shortcut is off', () => {
    const onOpenChange = vi.fn()
    render(<SidebarProvider keyboardShortcut={false} open onOpenChange={onOpenChange} />)
    expect(ctrlB().defaultPrevented).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does not write a host-wide sidebar cookie when persistence is off', () => {
    document.cookie = 'sidebar_state=; max-age=0; path=/'
    const onOpenChange = vi.fn()
    render(
      <SidebarProvider open onOpenChange={onOpenChange} persistState={false}>
        <SidebarTrigger />
      </SidebarProvider>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.cookie).not.toContain('sidebar_state')
  })

  it('keeps the official defaults otherwise', () => {
    const onOpenChange = vi.fn()
    render(<SidebarProvider open onOpenChange={onOpenChange} />)
    expect(ctrlB().defaultPrevented).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
