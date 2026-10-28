import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { ApiError } from '../api'
import type { PendingElicitation } from '../session/conversationReducer'
import { ElicitationPrompt } from './ElicitationPrompt'
import { PermissionPrompt } from './PermissionPrompt'

const t = createTranslator('en')
const options = [
  { id: 'always', label: 'Always Allow all Bash', kind: 'allow_always' },
  { id: 'allow', label: 'Allow this Bash command', kind: 'allow_once' },
  { id: 'reject', label: 'Reject this Bash command', kind: 'reject_once' },
]

describe('PermissionPrompt', () => {
  it('names the tool, offers each option as a decision, and takes 1–9', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(
      <PermissionPrompt
        deadlineMs={Date.now() + 90_000}
        heading="Analyst asks permission · For Structured pruning"
        options={options}
        requestId="q1"
        t={t}
        tool="pytest -q"
        onResolve={onResolve}
      />,
    )
    const card = screen.getByTestId('permission-queue-card')
    // The official Confirmation (ADR 0242), kept a named group rather than an alert.
    expect(card).toHaveAttribute('data-slot', 'alert')
    expect(card).toHaveAttribute('role', 'group')
    expect(card).toHaveAttribute('data-focus-key', 'permission:q1')
    // The dock/heading rules left kubecode.css with #261; no dead legacy hooks remain.
    expect(card.outerHTML).not.toMatch(/kubecode-permission-(dock|heading)/)
    expect(card).toHaveTextContent('Analyst asks permission · For Structured pruning')
    expect(card).toHaveTextContent('pytest -q')
    expect(screen.getByTestId('permission-countdown')).toHaveTextContent('2m expires')
    expect(screen.getByRole('button', { name: 'Allow all' })).toHaveAttribute('title', '1 — Always Allow all Bash')
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveAttribute('data-variant', 'outline')
    fireEvent.keyDown(card, { key: '2' })
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('allow'))
  })

  it('is a named group that announces only what changes, never the ticking countdown', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('network'))
    render(<PermissionPrompt deadlineMs={Date.now() + 90_000} heading="Analyst asks permission" options={options} requestId="q1" t={t} tool="pytest" onResolve={onResolve} />)
    const card = screen.getByRole('group', { name: 'Analyst asks permission: pytest' })
    expect(card).toHaveAttribute('data-focus-key', 'permission:q1')
    expect(card).not.toHaveAttribute('aria-live')
    expect(card.querySelector('[aria-live]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your answer was not recorded. Try again.')
  })

  it('hands focus to the next prompt, or else the composer, once an answered prompt goes (#229)', async () => {
    const Harness = ({ ids }: { ids: string[] }) => (
      <div>
        {ids.map((id) => <PermissionPrompt deadlineMs={null} key={id} options={options} requestId={id} t={t} tool="pytest" onResolve={vi.fn()} />)}
        <textarea aria-label="composer" className="kubecode-composer-textarea" />
      </div>
    )
    const { rerender } = render(<Harness ids={['q1', 'q2']} />)
    const first = document.querySelector<HTMLElement>('[data-focus-key="permission:q1"]')!
    act(() => first.focus())
    rerender(<Harness ids={['q2']} />)
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-focus-key', 'permission:q2'))
    rerender(<Harness ids={[]} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'composer' })))
  })

  it('leaves focus alone when the prompt goes while focus is elsewhere', async () => {
    const Harness = ({ show }: { show: boolean }) => (
      <div>
        {show && <PermissionPrompt deadlineMs={null} options={options} requestId="q1" t={t} tool="pytest" onResolve={vi.fn()} />}
        <button type="button">elsewhere</button>
        <textarea aria-label="composer" className="kubecode-composer-textarea" />
      </div>
    )
    const { rerender } = render(<Harness show />)
    const other = screen.getByRole('button', { name: 'elsewhere' })
    act(() => other.focus())
    rerender(<Harness show={false} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.activeElement).toBe(other)
  })

  it('shows no countdown without a deadline, and never a 0 s one once a deadline passed', () => {
    const { rerender } = render(<PermissionPrompt deadlineMs={null} options={options} requestId="q1" t={t} tool="pytest" onResolve={vi.fn()} />)
    expect(screen.queryByTestId('permission-countdown')).not.toBeInTheDocument()
    rerender(<PermissionPrompt deadlineMs={Date.now() - 1_000} options={options} requestId="q1" t={t} tool="pytest" onResolve={vi.fn()} />)
    expect(screen.queryByTestId('permission-countdown')).not.toBeInTheDocument()
  })

  it('stays busy while the answer is recorded, and keeps the prompt when it is not', async () => {
    let fail!: (cause: unknown) => void
    const onResolve = vi.fn(() => new Promise<void>((_, reject) => { fail = reject }))
    render(<PermissionPrompt deadlineMs={null} options={options} requestId="q1" t={t} tool="pytest" onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onResolve).toHaveBeenCalledTimes(1)
    await act(async () => fail(new Error('network')))
    expect(screen.getByRole('alert')).toHaveTextContent('Your answer was not recorded. Try again.')
    expect(screen.getByRole('alert')).toHaveAttribute('data-slot', 'alert')
    expect(screen.getByTestId('permission-queue-card')).toBeInTheDocument()
  })

  it('says a request answered elsewhere, timed out, or stopped is no longer waiting', async () => {
    const onGone = vi.fn()
    const onResolve = vi.fn().mockRejectedValue(new ApiError('permission_not_found', 'gone', 404))
    render(<PermissionPrompt deadlineMs={null} options={options} requestId="q1" t={t} tool="pytest" onGone={onGone} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(await screen.findByRole('status')).toHaveTextContent('This is no longer waiting')
    expect(onGone).toHaveBeenCalled()
  })
})

describe('ElicitationPrompt', () => {
  const elicitation: PendingElicitation = {
    requestId: 'e1',
    message: 'Which split?',
    properties: [{ id: 'split', label: 'Split', description: '', type: 'string', options: [], required: true, defaultValue: '' }],
  }

  it('asks the question, submits only a complete answer, and can decline', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    const onAnswerChange = vi.fn()
    const { rerender } = render(
      <ElicitationPrompt answers={{}} elicitation={elicitation} t={t} onAnswerChange={onAnswerChange} onResolve={onResolve} />,
    )
    const prompt = screen.getByText('Which split?').closest('[data-focus-key]')
    expect(prompt).toHaveAttribute('data-focus-key', 'input:e1')
    // The focus target is a named group, so arriving on it says what it is.
    expect(screen.getByRole('group', { name: 'Answer Agent question: Which split?' })).toBe(prompt)
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Split'), { target: { value: 'val' } })
    expect(onAnswerChange).toHaveBeenCalledWith('split', 'val')
    rerender(<ElicitationPrompt answers={{ split: 'val' }} elicitation={elicitation} t={t} onAnswerChange={onAnswerChange} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(true))
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(false))
  })
})

describe('PermissionPrompt resolving morph (ADR 0257, slice D)', () => {
  it('collapses to the compact outcome row while the answer awaits the snapshot, and options cannot be answered twice', async () => {
    let settle: (() => void) | undefined
    const onResolve = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))
    const { container, rerender } = render(
      <PermissionPrompt options={options} requestId="q2" resolving t={t} tool="pytest -q" onResolve={onResolve} />,
    )
    const card = screen.getByTestId('permission-queue-card')
    expect(card).toHaveAttribute('data-resolving')
    // The options are gone (none can be answered twice); the outcome line says
    // the answer is recorded and the removal follows the snapshot.
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(screen.getByText('pytest -q')).toBeInTheDocument()
    expect(screen.getByText('Answer recorded — updating…')).toBeInTheDocument()

    // The authoritative snapshot drops the card; until then nothing re-opens.
    rerender(
      <PermissionPrompt options={options} requestId="q2" resolving={false} t={t} tool="pytest -q" onResolve={onResolve} />,
    )
    expect(container.querySelectorAll('button')).toHaveLength(options.length)
    void settle
  })

  it('still answers from the full card when it is the caller resolving, then keeps the failure audible', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('transport refused'))
    render(
      <PermissionPrompt options={options} requestId="q3" t={t} tool="pytest -q" onResolve={onResolve} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    // The refusal stays audible in the card until the reader answers again.
    await waitFor(() => expect(screen.getByText('Your answer was not recorded. Try again.')).toBeInTheDocument())
  })
})
