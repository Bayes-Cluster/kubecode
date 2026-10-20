import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi, Member } from '../../api'
import { applyInspect, popEntry, type InspectorEntry, type InspectorStack } from '../location/inspector'
import { InspectorServicesContext, useInspectionRecord, useInspectorEntry, type InspectorServices } from './inspectorContext'
import { InspectorPane } from './InspectorPane'
import { InspectorPanel } from './InspectorPanel'
import type { InspectorPanelProps, InspectorPanels } from './inspectorPanels'
import type { InspectorPresentation } from './useInspectorPresentation'

const t = createTranslator('en')

const services: InspectorServices = {
  agents: [],
  api: {} as KubecodeApi,
  connectionState: 'live',
  events: [],
  roster: [{ id: 'm1', name: 'Analyst' } as Member],
  sessionCatalog: [],
  t,
  teams: [],
  onConversationCreated: vi.fn(),
}

const evidenceA1: InspectorEntry = { kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: '3f' } }

function TaskPanel({ entry }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'task' }>>) {
  const inspector = useInspectorEntry()
  const [redraws, setRedraws] = useState(0)
  return (
    <InspectorPanel title={entry.id === 'r1' ? 'Pruning heads' : entry.id}>
      <input aria-label="note" />
      <button type="button" onClick={() => inspector.push(evidenceA1)}>open evidence</button>
      <button
        data-focus-key="evidence:artifact:a1"
        key={redraws}
        type="button"
        onClick={() => {
          inspector.push(evidenceA1, { from: 'evidence:artifact:a1' })
          setRedraws((value) => value + 1)
        }}
      >
        open evidence and redraw
      </button>
      <button type="button" onClick={() => inspector.push({ kind: 'member', id: 'gone' })}>open a removed member</button>
    </InspectorPanel>
  )
}

function MemberPanel({ entry }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'member' }>>) {
  const member = services.roster.find((item) => item.id === entry.id)
  return (
    <InspectorPanel status={member ? 'ready' : 'unavailable'} title={member?.name ?? 'Member details'}>
      <p>who they are</p>
    </InspectorPanel>
  )
}

function EvidencePanel({ entry }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'evidence' }>>) {
  const record = useInspectionRecord()
  const ref = { kind: entry.ref.kind, id: entry.ref.id }
  const shown = record.displayedRevision(ref)
  return (
    <InspectorPanel title={`${entry.ref.kind}:${entry.ref.id}`}>
      <button type="button" onClick={() => record.markDisplayed(ref, entry.ref.revision ?? null)}>display</button>
      <p>{shown === undefined ? 'never displayed' : `displayed ${shown}`}</p>
    </InspectorPanel>
  )
}

function ResourcePanel({ entry }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'resource' }>>) {
  return <InspectorPanel title={entry.ref.id}><p>live record</p></InspectorPanel>
}

const panels: InspectorPanels = { task: TaskPanel, member: MemberPanel, evidence: EvidencePanel, resource: ResourcePanel }

function Host({
  initial,
  label = 'stack',
  onClose,
  presentation = 'side',
}: {
  initial: InspectorStack
  label?: string
  onClose?: () => void
  presentation?: InspectorPresentation
}) {
  const [stack, setStack] = useState<InspectorStack>(initial)
  return (
    <section aria-label={label}>
      <button type="button" onClick={() => setStack(initial)}>reopen {label}</button>
      <InspectorPane
        originLabel="General"
        panels={panels}
        presentation={presentation}
        projectId="p1"
        stack={stack}
        t={t}
        onBack={() => setStack(popEntry)}
        onClose={() => { onClose?.(); setStack([]) }}
        onPush={(entry) => setStack((current) => applyInspect(current, entry, 'push'))}
        onReplace={(entry) => setStack((current) => applyInspect(current, entry, 'replace'))}
      />
    </section>
  )
}

function mount(props: Parameters<typeof Host>[0]) {
  return render(
    <InspectorServicesContext.Provider value={services}>
      <Host {...props} />
    </InspectorServicesContext.Provider>,
  )
}

const task: InspectorEntry = { kind: 'task', id: 'r1' }

function entrySection(container: HTMLElement, depth: number) {
  const section = container.querySelector<HTMLElement>(`.kubecode-inspector-entry[data-depth="${depth}"]`)
  if (!section) throw new Error(`no entry at depth ${depth}`)
  return section
}

describe('InspectorPane header', () => {
  it('beside the view, the first entry only closes', async () => {
    mount({ initial: [task] })
    expect(await screen.findByRole('button', { name: 'Close details' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument()
  })

  it('beside the view, a deeper entry goes back to the one below by its title, and closes', async () => {
    mount({ initial: [task, evidenceA1] })
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Pruning heads' }))
    expect(await screen.findByRole('button', { name: 'open evidence' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open evidence' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('over the view, the first entry goes back to the view and has no close', async () => {
    const onClose = vi.fn()
    mount({ initial: [task], onClose, presentation: 'screen' })
    fireEvent.click(await screen.findByRole('button', { name: 'Back to General' }))
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
  })

  it('over the view, a deeper entry goes back to the one below and closes straight to the view', async () => {
    mount({ initial: [task, evidenceA1], presentation: 'screen' })
    expect(await screen.findByRole('button', { name: 'Back to Pruning heads' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('renders one header per entry: panels never draw their own back or close', async () => {
    const view = mount({ initial: [task, evidenceA1] })
    await screen.findByRole('button', { name: 'Back to Pruning heads' })
    for (const depth of [0, 1]) {
      expect(entrySection(view.container, depth).querySelectorAll('header.kubecode-view-header')).toHaveLength(1)
    }
  })

  it('names the aside after what is on top', async () => {
    const view = mount({ initial: [task] })
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    view.unmount()
    const member = mount({ initial: [{ kind: 'member', id: 'm1' }] })
    expect(screen.getByRole('complementary', { name: 'Analyst' })).toBeInTheDocument()
    member.unmount()
    const evidence = mount({ initial: [task, evidenceA1] })
    expect(screen.getByRole('complementary', { name: 'Evidence details' })).toBeInTheDocument()
    evidence.unmount()
    mount({ initial: [{ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }] })
    expect(screen.getByRole('complementary', { name: 'Resource details' })).toBeInTheDocument()
  })

  it('keeps Back and Close on something that is no longer available', async () => {
    mount({ initial: [task] })
    fireEvent.click(await screen.findByRole('button', { name: 'open a removed member' }))
    expect(await screen.findByText('This item is no longer available.')).toBeInTheDocument()
    expect(screen.queryByText('who they are')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to Pruning heads' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close details' })).toBeInTheDocument()
  })
})

describe('InspectorPane stack', () => {
  it('keeps a covered entry mounted, inert, and hidden without losing what was typed in it', async () => {
    const view = mount({ initial: [task] })
    fireEvent.change(await screen.findByRole('textbox', { name: 'note' }), { target: { value: 'unsent note' } })
    fireEvent.click(screen.getByRole('button', { name: 'open evidence' }))
    await screen.findByRole('button', { name: 'Back to Pruning heads' })
    const covered = entrySection(view.container, 0)
    expect(covered).toHaveAttribute('inert')
    expect(covered).toHaveAttribute('aria-hidden', 'true')
    expect(covered).not.toHaveAttribute('hidden')
    expect(covered).toHaveAttribute('data-top', 'false')
    expect(within(covered).getByDisplayValue('unsent note')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pruning heads' }))
    expect(entrySection(view.container, 0)).not.toHaveAttribute('inert')
    expect(screen.getByRole('textbox', { name: 'note' })).toHaveValue('unsent note')
  })

  it('focuses the new top on push and returns focus to what opened it on Back', async () => {
    const view = mount({ initial: [task] })
    const opener = await screen.findByRole('button', { name: 'open evidence' })
    opener.focus()
    fireEvent.click(opener)
    expect(entrySection(view.container, 1)).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pruning heads' }))
    expect(screen.getByRole('button', { name: 'open evidence' })).toHaveFocus()
  })

  it('returns focus to the focus key when what opened the entry was redrawn', async () => {
    const view = mount({ initial: [task] })
    const opener = await screen.findByRole('button', { name: 'open evidence and redraw' })
    opener.focus()
    fireEvent.click(opener)
    expect(opener.isConnected).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pruning heads' }))
    const redrawn = screen.getByRole('button', { name: 'open evidence and redraw' })
    expect(redrawn).not.toBe(opener)
    expect(redrawn).toHaveFocus()
    expect(entrySection(view.container, 0)).toContainElement(redrawn)
  })

  it('pops one level on Escape, but not while typing or composing', async () => {
    const view = mount({ initial: [task, evidenceA1] })
    const display = await screen.findByRole('button', { name: 'display' })
    fireEvent.keyDown(display, { key: 'Escape', isComposing: true })
    expect(entrySection(view.container, 1)).toBeInTheDocument()
    fireEvent.keyDown(display, { key: 'Escape' })
    expect(view.container.querySelector('[data-depth="1"]')).toBeNull()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'note' }), { key: 'Escape' })
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: 'open evidence' }), { key: 'Escape' })
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })
})

describe('InspectorPane inspection record', () => {
  it('forgets what was displayed when the inspector closes', async () => {
    mount({ initial: [task, evidenceA1] })
    fireEvent.click(await screen.findByRole('button', { name: 'display' }))
    expect(screen.getByText('displayed 3f')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    fireEvent.click(screen.getByRole('button', { name: 'reopen stack' }))
    expect(await screen.findByText('never displayed')).toBeInTheDocument()
  })

  it('keeps it through Back within one stack', async () => {
    mount({ initial: [task, evidenceA1] })
    fireEvent.click(await screen.findByRole('button', { name: 'display' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pruning heads' }))
    fireEvent.click(screen.getByRole('button', { name: 'open evidence' }))
    expect(await screen.findByText('displayed 3f')).toBeInTheDocument()
  })

  it('is not shared between two stacks', async () => {
    render(
      <InspectorServicesContext.Provider value={services}>
        <Host initial={[task, evidenceA1]} label="General" />
        <Host initial={[task, evidenceA1]} label="Kanban" />
      </InspectorServicesContext.Provider>,
    )
    const general = screen.getByRole('region', { name: 'General' })
    const kanban = screen.getByRole('region', { name: 'Kanban' })
    fireEvent.click(await within(general).findByRole('button', { name: 'display' }))
    expect(within(general).getByText('displayed 3f')).toBeInTheDocument()
    expect(within(kanban).getByText('never displayed')).toBeInTheDocument()
  })
})
