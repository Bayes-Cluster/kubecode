import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DecisionButton } from '@/components/workspace/DecisionButton'
import { MemberAvatar, MemberIdentity } from '@/components/workspace/MemberIdentity'
import { MoreActions } from '@/components/workspace/MoreActions'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import { PauseButton, StopButton } from '@/components/workspace/SendButton'
import { ViewHeader } from '@/components/workspace/ViewHeader'
import { SidebarProvider } from '@/components/ui/sidebar'
import { WorkspaceNav } from '@/kubecode/app/WorkspaceNav'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'

/** The lucide class of the glyph a component renders, to compare what is drawn with the map. */
function glyphClass(Glyph: ComponentType) {
  const { container, unmount } = render(<Glyph />)
  const name = [...(container.querySelector('svg')?.classList ?? [])].find((item) => item.startsWith('lucide-'))
  unmount()
  return name
}
function renderedGlyph(element: Element) {
  return [...(element.querySelector('svg')?.classList ?? [])].find((item) => item.startsWith('lucide-'))
}

describe('MemberIdentity (ADR 0227)', () => {
  it('shows who someone is: initials, name, handle, and the role in words', () => {
    render(<MemberIdentity handle="analyst" name="Data Analyst" role="specialist" roleLabel="Specialist · Analysis" />)
    expect(screen.getByText('Data Analyst')).toBeInTheDocument()
    expect(screen.getByText('@analyst')).toBeInTheDocument()
    expect(screen.getByText('Specialist · Analysis')).toBeInTheDocument()
    const avatar = screen.getByTestId('member-avatar')
    expect(avatar).toHaveTextContent('DA')
    expect(avatar).toHaveAttribute('data-role', 'specialist')
    // The avatar repeats the name, so it is hidden from assistive technology.
    expect(avatar).toHaveAttribute('aria-hidden', 'true')
    // ADR 0247: the official Avatar with its fallback.
    expect(avatar).toHaveAttribute('data-slot', 'avatar')
    expect(avatar.querySelector('[data-slot="avatar-fallback"]')).toHaveTextContent('DA')
  })

  it('makes an openable name the official link Button', () => {
    const onOpen = vi.fn()
    render(<MemberIdentity name="Analyst" role="specialist" onOpen={onOpen} />)
    const name = screen.getByRole('button', { name: 'Analyst' })
    expect(name).toHaveAttribute('data-slot', 'button')
    fireEvent.click(name)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('never shows an ordinary membership as a status, and shows one that needs attention in words', () => {
    const { container, rerender } = render(<MemberIdentity handle="general" name="General" role="manager" roleLabel="Project manager" />)
    expect(container.querySelector('[data-slot="badge"]')).toBeNull()
    expect(screen.queryByText(/active/i)).toBeNull()
    rerender(
      <MemberIdentity
        attention={{ label: 'Needs setup', tone: 'warn' }}
        handle="general"
        name="General"
        role="manager"
        roleLabel="Project manager"
      />,
    )
    expect(screen.getByText('Needs setup')).toHaveAttribute('data-tone', 'warn')
  })

  it('derives initials from one word, many words, and symbols', () => {
    const { rerender } = render(<MemberAvatar name="general" role="manager" />)
    expect(screen.getByTestId('member-avatar')).toHaveTextContent('G')
    rerender(<MemberAvatar name="  code   review bot " role="specialist" />)
    expect(screen.getByTestId('member-avatar')).toHaveTextContent('CR')
    rerender(<MemberAvatar name="分析师" role="specialist" />)
    expect(screen.getByTestId('member-avatar')).toHaveTextContent('分')
    rerender(<MemberAvatar name="" role="system" />)
    expect(screen.getByTestId('member-avatar').textContent).toBe('?')
    // Punctuation is skipped, digits count, and a flag stays whole.
    rerender(<MemberAvatar name="(Bot) Xavier" role="specialist" />)
    expect(screen.getByTestId('member-avatar')).toHaveTextContent('BX')
    rerender(<MemberAvatar name="3D Analyst" role="specialist" />)
    expect(screen.getByTestId('member-avatar')).toHaveTextContent('3A')
    rerender(<MemberAvatar name="🇩🇪 Team" role="specialist" />)
    expect(screen.getByTestId('member-avatar').textContent).toBe('🇩🇪')
  })

  it('shows reported activity and details, and opens the profile from the name', () => {
    const onOpen = vi.fn()
    render(
      <MemberIdentity
        activity="Running"
        handle="analyst"
        meta="10:42"
        name="Analyst"
        role="specialist"
        onOpen={onOpen}
      />,
    )
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('10:42')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Analyst' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('ReferenceChip (ADR 0227)', () => {
  it('composes the official Attachment: its trigger opens, its action removes (#258)', () => {
    render(<ReferenceChip kind="file" kindLabel="File" removeLabel="Remove notes.md" title="notes.md" onOpen={vi.fn()} onRemove={vi.fn()} />)
    const open = screen.getByRole('button', { name: 'File notes.md' })
    expect(open).toHaveAttribute('data-slot', 'attachment-trigger')
    expect(screen.getByRole('button', { name: 'Remove notes.md' })).toHaveAttribute('data-slot', 'attachment-action')
    expect(open.closest('[data-slot="attachment"]')).not.toBeNull()
  })

  it('names the object, its kind, and its version, and opens it', () => {
    const onOpen = vi.fn()
    render(<ReferenceChip kind="evidence" kindLabel="Evidence" title="results.csv" version="v3" onOpen={onOpen} />)
    // The name is the visible text, preceded by the kind.
    const chip = screen.getByRole('button', { name: 'Evidence results.csv v3' })
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('says in words when the object changed or is gone, and is plain text when it cannot open', () => {
    const { rerender } = render(
      <ReferenceChip kind="file" kindLabel="File" state={{ kind: 'changed', label: 'Changed since cited' }} title="notes.md" />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('Changed since cited')).toBeInTheDocument()
    rerender(<ReferenceChip kind="file" kindLabel="File" state={{ kind: 'removed', label: 'No longer exists' }} title="notes.md" />)
    expect(screen.getByText('notes.md').closest('[data-reference-state]')).toHaveAttribute('data-reference-state', 'removed')
  })

  it('names an openable chip with its changed or removed state too', () => {
    const { rerender } = render(
      <ReferenceChip kind="file" kindLabel="File" state={{ kind: 'changed', label: 'Changed since cited' }} title="notes.md" onOpen={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'File notes.md Changed since cited' })).toBeInTheDocument()
    rerender(<ReferenceChip kind="file" kindLabel="File" state={{ kind: 'removed', label: 'No longer exists' }} title="notes.md" onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'File notes.md No longer exists' })).toBeInTheDocument()
  })

  it('cannot open what cannot be read, and can be removed from a draft', () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    const { rerender } = render(
      <ReferenceChip
        kind="discussion"
        kindLabel="Imported discussion"
        state={{ kind: 'unavailable', label: 'Cannot be read here' }}
        title="Private notes"
        onOpen={onOpen}
      />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    rerender(
      <ReferenceChip kind="evidence" kindLabel="Evidence" removeLabel="Remove results.csv" title="results.csv" onOpen={onOpen} onRemove={onRemove} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove results.csv' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('ViewHeader (ADR 0227)', () => {
  it('titles a view, describes it, and holds its actions; Back only when given', () => {
    const { rerender } = render(
      <ViewHeader actions={<button type="button">Add</button>} description="Everyone in this Workspace" title="Members" />,
    )
    expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByText('Everyone in this Workspace')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    const onBack = vi.fn()
    rerender(<ViewHeader back={{ label: 'Back', onBack }} title="Structured pruning" />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('closes a detail apart from going back, and shows facts under the title', () => {
    const onClose = vi.fn()
    render(<ViewHeader close={{ label: 'Close details', onClose }} level={3} meta={<span>In review</span>} title="Structured pruning" />)
    expect(screen.getByRole('heading', { level: 3, name: 'Structured pruning' })).toBeInTheDocument()
    expect(screen.getByText('In review')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('DecisionButton (ADR 0227)', () => {
  it('decides in words, says why it cannot, and keeps focus while it records', () => {
    const onDecide = vi.fn()
    const { rerender } = render(<DecisionButton variant="primary" onDecide={onDecide}>Accept results</DecisionButton>)
    fireEvent.click(screen.getByRole('button', { name: 'Accept results' }))
    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Accept results' })).toHaveAttribute('data-variant', 'primary')
    rerender(<DecisionButton variant="destructive" onDecide={onDecide}>Discard</DecisionButton>)
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveAttribute('data-variant', 'destructive')
    rerender(<DecisionButton onDecide={onDecide}>Send back</DecisionButton>)
    expect(screen.getByRole('button', { name: 'Send back' })).toHaveAttribute('data-variant', 'secondary')
    rerender(<DecisionButton disabledReason="Look at the changed evidence first." onDecide={onDecide}>Accept results</DecisionButton>)
    const blocked = screen.getByRole('button', { name: 'Accept results' })
    expect(blocked).toBeDisabled()
    expect(blocked).toHaveAccessibleDescription('Look at the changed evidence first.')
    rerender(<DecisionButton busy onDecide={onDecide}>Accept results</DecisionButton>)
    const busy = screen.getByRole('button', { name: 'Accept results' })
    expect(busy.querySelector('.animate-spin')).not.toBeNull()
    busy.focus()
    expect(busy).toHaveFocus()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(busy)
    expect(onDecide).toHaveBeenCalledTimes(1)
  })
})

describe('MoreActions (ADR 0227)', () => {
  it('keeps secondary actions behind one labelled control and runs the chosen one', async () => {
    const copy = vi.fn()
    render(<MoreActions items={[{ id: 'copy', label: 'Copy link', onSelect: copy }]} label="More actions for this message" />)
    const trigger = screen.getByRole('button', { name: 'More actions for this message' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy link' }))
    expect(copy).toHaveBeenCalledTimes(1)
  })
})

describe('PauseButton and StopButton (ADR 0227)', () => {
  it('pauses new work in the scope it names, apart from stopping a run; its name never flips', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <>
        <PauseButton label="Pause new work on this Task" paused={false} onToggle={onToggle} />
        <StopButton label="Stop Analyst's run" onStop={vi.fn()} />
      </>,
    )
    const pause = screen.getByRole('button', { name: 'Pause new work on this Task' })
    expect(pause).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(pause)
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<PauseButton label="Pause new work on this Task" paused onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: 'Pause new work on this Task' })).toHaveAttribute('aria-pressed', 'true')
    rerender(<PauseButton busy label="Pause new work on this Task" paused onToggle={onToggle} />)
    const busy = screen.getByRole('button', { name: 'Pause new work on this Task' })
    expect(busy).not.toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy.querySelector('.animate-spin')).not.toBeNull()
    fireEvent.click(busy)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('what the controls draw (ADR 0227)', () => {
  it('draws stop, pause, resume, and send with the glyphs the map names, all different', () => {
    const { rerender } = render(
      <>
        <StopButton label="Stop run" onStop={vi.fn()} />
        <PauseButton label="Pause new work" paused={false} onToggle={vi.fn()} />
      </>,
    )
    const stop = renderedGlyph(screen.getByRole('button', { name: 'Stop run' }))
    const pause = renderedGlyph(screen.getByRole('button', { name: 'Pause new work' }))
    expect(stop).toBe(glyphClass(WORKSPACE_COMMAND_ICONS.stopRun.Icon))
    expect(pause).toBe(glyphClass(WORKSPACE_COMMAND_ICONS.pauseOrchestration.Icon))
    expect(stop).not.toBe(pause)
    rerender(<PauseButton label="Pause new work" paused onToggle={vi.fn()} />)
    expect(renderedGlyph(screen.getByRole('button', { name: 'Pause new work' }))).toBe(glyphClass(WORKSPACE_COMMAND_ICONS.resumeOrchestration.Icon))
  })

  it('draws each navigation destination with its own glyph from the map', () => {
    const t = ((key: string) => key) as never
    render(
      <WorkspaceNav
        active="general"
        members={[]}
        needsYou={[]}
        t={t}
        taskCount={0}
        onInspectMember={vi.fn()}
        onOpen={vi.fn()}
        onOpenDm={vi.fn()}
        onOpenTarget={vi.fn()}
      />,
      // The navigation renders inside the shell's official Sidebar.
      { wrapper: SidebarProvider },
    )
    const expected = {
      'kubecode.channel.general': WORKSPACE_DESTINATION_ICONS.general,
      'kubecode.nav.board': WORKSPACE_DESTINATION_ICONS.board,
      'kubecode.nav.resources': WORKSPACE_DESTINATION_ICONS.resources,
      'kubecode.nav.members': WORKSPACE_DESTINATION_ICONS.members,
    }
    for (const [label, entry] of Object.entries(expected)) {
      expect(renderedGlyph(screen.getByRole('button', { name: label }))).toBe(glyphClass(entry.Icon))
    }
  })
})