import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { createTranslator } from '@/lib/i18n'

import type { ChannelThread } from '../api'
import { ChannelNavigator } from './ChannelNavigator'

const t = createTranslator('en')
const thread = (id: string, title: string, research_id: string | null = null) => ({ id, title, research_id }) as ChannelThread

describe('ChannelNavigator', () => {
  it('lists the latest five Threads as official Sidebar menu buttons that open them', () => {
    const onOpenThread = vi.fn()
    render(
      <ChannelNavigator
        active={false}
        onOpen={vi.fn()}
        onOpenThread={onOpenThread}
        t={t}
        threads={[1, 2, 3, 4, 5, 6].map((index) => thread(`t${index}`, `Thread ${index}`, index === 1 ? 'r1' : null))}
        threadsOnly
      />,
      { wrapper: SidebarProvider },
    )
    const group = screen.getByRole('region', { name: 'Discussion threads' })
    expect(group).toHaveAttribute('data-slot', 'sidebar-group')
    const rows = screen.getAllByRole('button')
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(row).toHaveAttribute('data-slot', 'sidebar-menu-button')
    expect(rows[0]).toHaveTextContent('linked')
    fireEvent.click(rows[1])
    expect(onOpenThread).toHaveBeenCalledWith('t2')
  })

  it('offers General first, marked as current, when it lists more than the Threads', () => {
    const onOpen = vi.fn()
    render(<ChannelNavigator active onOpen={onOpen} onOpenThread={vi.fn()} t={t} threads={[]} />, { wrapper: SidebarProvider })
    const general = screen.getByRole('button', { name: 'General' })
    expect(general).toHaveAttribute('aria-current', 'page')
    expect(general).toHaveAttribute('data-active', 'true')
    fireEvent.click(general)
    expect(onOpen).toHaveBeenCalled()
  })
})
