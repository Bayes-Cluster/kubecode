import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi, TaskExecution } from '../api'
import { RoundPauseControl } from './RoundPauseControl'

const t = createTranslator('en')

function glyphOf(element: Element) {
  return [...(element.querySelector('svg')?.classList ?? [])].find((item) => item.startsWith('lucide-'))
}
function glyphClass(Glyph: React.ComponentType) {
  const { container, unmount } = render(<Glyph />)
  const name = [...(container.querySelector('svg')?.classList ?? [])].find((item) => item.startsWith('lucide-'))
  unmount()
  return name
}

function control(paused: boolean, api: Partial<KubecodeApi> = {}) {
  const execution = { round_id: 'round1', round_number: 1, paused, policy_revision: 3 } as unknown as TaskExecution
  render(
    <RoundPauseControl
      api={api as KubecodeApi}
      execution={execution}
      projectId="p1"
      t={t}
      task={{ id: 'r1', title: 'Structured pruning' }}
      onChanged={vi.fn()}
    />,
  )
  return screen.getByRole('button', { name: 'Pause new work on Structured pruning' })
}

describe('RoundPauseControl (ADR 0232, ADR 0255)', () => {
  it('is the official Toggle: its name never changes, the pressed state says whether new work is paused', () => {
    const pause = control(false)
    expect(pause).toHaveAttribute('data-slot', 'toggle')
    expect(pause).toHaveAttribute('aria-pressed', 'false')
    expect(pause).toHaveTextContent('Pause new work')
    expect(glyphOf(pause)).toBe(glyphClass(WORKSPACE_COMMAND_ICONS.pauseOrchestration.Icon))
  })

  it('shows resume when paused, and keeps focus while the change is recorded', async () => {
    const setRoundExecutionPolicy = vi.fn(() => new Promise<never>(() => undefined))
    const pause = control(true, { setRoundExecutionPolicy } as unknown as Partial<KubecodeApi>)
    expect(pause).toHaveAttribute('aria-pressed', 'true')
    expect(glyphOf(pause)).toBe(glyphClass(WORKSPACE_COMMAND_ICONS.resumeOrchestration.Icon))
    fireEvent.click(pause)
    expect(setRoundExecutionPolicy).toHaveBeenCalledWith('p1', 'round1', 3, { paused: false })
    const busy = await screen.findByRole('button', { name: 'Pause new work on Structured pruning', busy: true })
    expect(busy).not.toBeDisabled()
    busy.focus()
    expect(busy).toHaveFocus()
    expect(busy.querySelector('.animate-spin')).not.toBeNull()
    fireEvent.click(busy)
    expect(setRoundExecutionPolicy).toHaveBeenCalledTimes(1)
  })
})
