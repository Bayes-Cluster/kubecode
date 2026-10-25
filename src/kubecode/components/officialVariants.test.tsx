import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Command, CommandList, CommandLoading } from '@/components/ui/command'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Item } from '@/components/ui/item'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { SidebarMenu, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider } from '@/components/ui/sidebar'

/**
 * ADR 0256: sizes and tones live in the official component once, as variants,
 * so no call site repaints a part by className.
 */
describe('official component variants (ADR 0256)', () => {
  it('Button meets the touch target on a coarse pointer in the roomy sizes, not in xs, icon-xs or inline, and wraps a decision', () => {
    render(
      <>
        <Button size="sm">Retry</Button>
        <Button aria-label="Close" size="icon-sm">x</Button>
        <Button size="xs">Dense</Button>
        <Button aria-label="Copy" size="icon-xs">c</Button>
        <Button size="wrap" variant="outline">Accept the results shown</Button>
        <Button size="inline" variant="link">Analyst</Button>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Retry' }).className).toContain('pointer-coarse:min-h-[44px]')
    const icon = screen.getByRole('button', { name: 'Close' })
    expect(icon.className).toContain('pointer-coarse:min-h-[44px]')
    expect(icon.className).toContain('pointer-coarse:min-w-[44px]')
    const wrap = screen.getByRole('button', { name: 'Accept the results shown' })
    expect(wrap).toHaveAttribute('data-size', 'wrap')
    expect(wrap.className).toContain('whitespace-normal')
    expect(wrap.className).toContain('h-auto')
    const inline = screen.getByRole('button', { name: 'Analyst' })
    expect(inline).toHaveAttribute('data-size', 'inline')
    expect(inline.className).toContain('p-0')
    expect(inline.className).not.toContain('pointer-coarse:min-h-[44px]')
    // Dense rows (file tree, terminal navigator, message actions) keep their height.
    expect(screen.getByRole('button', { name: 'Dense' }).className).not.toContain('pointer-coarse:')
    expect(screen.getByRole('button', { name: 'Copy' }).className).not.toContain('pointer-coarse:')
  })

  it('Empty has a compact size and an outline variant', () => {
    const { rerender } = render(<Empty size="compact"><EmptyDescription>Nothing</EmptyDescription></Empty>)
    const empty = screen.getByText('Nothing').parentElement as HTMLElement
    expect(empty).toHaveAttribute('data-size', 'compact')
    expect(empty.className).toContain('p-4')
    expect(empty.className).not.toContain('md:p-12')
    rerender(<Empty variant="outline"><EmptyDescription>Nothing</EmptyDescription></Empty>)
    expect(screen.getByText('Nothing').parentElement).toHaveAttribute('data-variant', 'outline')
    expect(screen.getByText('Nothing').parentElement?.className).toMatch(/\bborder\b/)
  })

  it('Card and Item have a compact size whose child owns the insets', () => {
    render(
      <>
        <Card data-testid="card" size="compact">card</Card>
        <Item data-testid="item" size="compact">item</Item>
        <Item asChild size="sm"><button type="button">row</button></Item>
      </>,
    )
    const card = screen.getByTestId('card')
    expect(card).toHaveAttribute('data-size', 'compact')
    expect(card.className).toContain('py-0')
    expect(card.className).toContain('gap-0')
    const item = screen.getByTestId('item')
    expect(item).toHaveAttribute('data-size', 'compact')
    expect(item.className).toMatch(/\bp-0\b/)
    // An interactive Item is a touch-sized target without a per-call class.
    expect(screen.getByRole('button', { name: 'row' }).className).toContain('[button&]:pointer-coarse:min-h-[44px]')
  })

  it('Alert has a warning variant on the semantic tokens', () => {
    render(<Alert variant="warning"><AlertDescription>Review soon</AlertDescription></Alert>)
    const alert = screen.getByRole('alert')
    expect(alert.className).toContain('text-warning-foreground')
  })

  it('FieldLabel has an option variant for one choice in a set', () => {
    render(
      <Field>
        <FieldLabel htmlFor="opt" variant="option">Include closed</FieldLabel>
        <input id="opt" type="checkbox" />
      </Field>,
    )
    const label = screen.getByText('Include closed')
    expect(label).toHaveAttribute('data-variant', 'option')
    expect(label.className).toContain('font-normal')
  })

  it('exports PopoverAnchor and CommandLoading, and sizes a sidebar sub-button lg', () => {
    render(
      <>
        <Popover><PopoverAnchor asChild><div data-testid="anchor">a</div></PopoverAnchor></Popover>
        <Command><CommandList><CommandLoading>Loading…</CommandLoading></CommandList></Command>
        <SidebarProvider>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSub>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton href="#" size="lg">Teammate</SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarProvider>
      </>,
    )
    expect(screen.getByTestId('anchor')).toHaveAttribute('data-slot', 'popover-anchor')
    expect(screen.getByText('Loading…').closest('[data-slot="command-loading"]')).not.toBeNull()
    const sub = screen.getByRole('link', { name: 'Teammate' })
    expect(sub).toHaveAttribute('data-size', 'lg')
    expect(sub.className).toContain('h-12')
  })
})
