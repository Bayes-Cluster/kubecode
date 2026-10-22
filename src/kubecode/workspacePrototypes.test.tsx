import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { prototypeHash, prototypeRequest, type PrototypeRequest } from '@/components/workspace/prototypes/prototypeRoute'
import { WorkspacePrototypes, WorkspacePrototypesRoute } from '@/components/workspace/prototypes/WorkspacePrototypes'

const base: PrototypeRequest = { screen: 'general', state: 'default', theme: 'light', locale: 'en', from: 'general' }

describe('prototype route', () => {
  it('reads screen, state, theme, language and origin, with safe defaults', () => {
    expect(prototypeRequest('#/controls')).toBeNull()
    expect(prototypeRequest('#/prototypes')).toEqual(base)
    expect(prototypeRequest('#/prototypes?screen=review&state=error&theme=dark&lang=de-DE&from=agents'))
      .toEqual({ screen: 'review', state: 'error', theme: 'dark', locale: 'de-DE', from: 'agents' })
    expect(prototypeRequest('#/prototypes?screen=nope&state=odd&lang=xx')).toEqual(base)
  })

  it('writes short hashes that read back the same', () => {
    expect(prototypeHash(base)).toBe('#/prototypes?screen=general')
    const full: PrototypeRequest = { screen: 'review', state: 'busy', theme: 'dark', locale: 'ja-JP', from: 'agents' }
    expect(prototypeRequest(prototypeHash(full))).toEqual(full)
  })
})

describe('Workspace prototypes', () => {
  it('marks fixture data and gives the three regions names', () => {
    render(<WorkspacePrototypes request={base} />)
    expect(screen.getByRole('note')).toHaveTextContent('Sample data only')
    expect(screen.getByRole('navigation', { name: 'Workspace places' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Materials' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument()
  })

  it('is built on the official components, themed through the Workspace tokens (ADR 0241)', () => {
    render(<WorkspacePrototypes request={base} />)
    expect(screen.getByTestId('workspace-prototypes')).not.toHaveAttribute('data-ws-components')
    expect(document.querySelector('[data-slot="attachment"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="input-group"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="avatar"]')).not.toBeNull()
  })

  it('General: a suggestion fills the draft, sending stays local, and a reference can be removed', async () => {
    render(<WorkspacePrototypes request={base} />)
    fireEvent.click(screen.getByRole('button', { name: 'Summarize the open questions' }))
    const box = screen.getByRole('textbox', { name: 'Message General' })
    expect(box).toHaveValue('Summarize the open questions')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Sample only, not sent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes/related-work.md' }))
    expect(screen.queryByRole('button', { name: 'Remove notes/related-work.md' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    expect(screen.getByRole('button', { name: 'Remove notes/related-work.md' })).toBeInTheDocument()
  })

  it.each(['busy', 'error', 'empty'] as const)('General renders its %s state', (state) => {
    render(<WorkspacePrototypes request={{ ...base, state }} />)
    if (state === 'busy') expect(screen.getAllByText('Writing a reply…').length).toBeGreaterThan(0)
    if (state === 'error') expect(screen.getByRole('alert')).toHaveTextContent('Not delivered')
    if (state === 'empty') expect(screen.getByText('Nothing in General yet')).toBeInTheDocument()
  })

  it('agents: a pending decision is made with text buttons, and a named run can be stopped', () => {
    render(<WorkspacePrototypes request={{ ...base, screen: 'agents' }} />)
    const decision = screen.getByRole('region', { name: 'Turing asks to go past the round limit' })
    fireEvent.click(within(decision).getByRole('button', { name: 'Allow this launch' }))
    expect(within(decision).getByText('You allowed this launch.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: "Stop Turing's run" }))
    expect(screen.queryByRole('button', { name: "Stop Turing's run" })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open the Task review' })).toHaveAttribute('href', '#/prototypes?screen=review&from=agents')
  })

  it('agents: decline, failure, and empty states', () => {
    const { unmount } = render(<WorkspacePrototypes request={{ ...base, screen: 'agents' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(screen.getByText('You declined this launch.')).toBeInTheDocument()
    unmount()
    const failed = render(<WorkspacePrototypes request={{ ...base, screen: 'agents', state: 'error' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent("Turing's run stopped")
    failed.unmount()
    render(<WorkspacePrototypes request={{ ...base, screen: 'agents', state: 'empty' }} />)
    expect(screen.getByText('No work is running or queued.')).toBeInTheDocument()
  })

  it('review: accept and send back are decisions; changed evidence blocks accepting with a reason', () => {
    const { unmount } = render(<WorkspacePrototypes request={{ ...base, screen: 'review' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept results' }))
    expect(screen.getByRole('status')).toHaveTextContent('Accepted (sample only')
    unmount()
    const back = render(<WorkspacePrototypes request={{ ...base, screen: 'review' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change' }), { target: { value: 'Add seed 4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
    expect(screen.getByRole('status')).toHaveTextContent('Sent back')
    back.unmount()
    render(<WorkspacePrototypes request={{ ...base, screen: 'review', state: 'error' }} />)
    const accept = screen.getByRole('button', { name: 'Accept results' })
    expect(accept).toBeDisabled()
    expect(accept).toHaveAccessibleDescription(/evidence changed/)
  })

  it('review: empty results and a Back to where it was opened from', () => {
    window.location.hash = '#/prototypes?screen=review&from=agents&state=empty'
    render(<WorkspacePrototypesRoute initial={{ ...base, screen: 'review', from: 'agents', state: 'empty' }} />)
    expect(screen.getByText('No results yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Needs you' }))
    expect(window.location.hash).toBe('#/prototypes?screen=agents')
    fireEvent(window, new HashChangeEvent('hashchange'))
    expect(screen.getByRole('complementary', { name: 'Work in progress' })).toBeInTheDocument()
  })

  it('localizes interface text', () => {
    render(<WorkspacePrototypes request={{ ...base, locale: 'de-DE' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Allgemein' })).toBeInTheDocument()
  })

  it.each(['general', 'agents', 'review'] as const)('%s: no English default from an official component leaks into de-DE', (screenName) => {
    const { container } = render(<WorkspacePrototypes request={{ ...base, screen: screenName, locale: 'de-DE' }} />)
    const defaults = ['What would you like to know?', 'Submit', 'Stop', 'Used 3 sources', 'Chain of Thought', 'Parameters', 'Result', 'Toggle plan', 'Loading', 'unknown', 'No messages yet']
    const named = [...container.querySelectorAll('[aria-label], [placeholder], [title]')]
      .flatMap((node) => ['aria-label', 'placeholder', 'title'].map((name) => node.getAttribute(name)))
    for (const text of defaults) {
      expect(named).not.toContain(text)
      expect(container.textContent).not.toContain(text)
    }
  })
})
