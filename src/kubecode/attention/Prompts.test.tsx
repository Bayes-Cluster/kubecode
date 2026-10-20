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
    expect(card).toHaveAttribute('data-focus-key', 'permission:q1')
    expect(card).toHaveTextContent('Analyst asks permission · For Structured pruning')
    expect(card).toHaveTextContent('pytest -q')
    expect(screen.getByTestId('permission-countdown')).toHaveTextContent('2m expires')
    expect(screen.getByRole('button', { name: 'Allow all' })).toHaveAttribute('title', '1 — Always Allow all Bash')
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveAttribute('data-variant', 'secondary')
    fireEvent.keyDown(card, { key: '2' })
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('allow'))
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
