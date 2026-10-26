import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyAction } from './message-actions'

/**
 * ADR 0257 §7: a copy succeeds into the success state, a refused clipboard
 * lands in the error state with the action still available, and duplicate
 * clicks while in flight write once.
 */

const ICON = <svg viewBox="0 0 16 16" data-testid="idle-icon" />
const CHECK = <svg viewBox="0 0 16 16" data-testid="copied-icon" />
const ERROR = <svg viewBox="0 0 16 16" data-testid="error-icon" />

function renderCopy(writeText: () => Promise<void>, onCopied?: (text: string) => void) {
  const writeTextMock = vi.fn(writeText)
  Object.assign(window.navigator, { clipboard: { writeText: writeTextMock } })
  const view = render(
    <CopyAction
      copiedIcon={CHECK}
      copiedLabel="Copied"
      errorIcon={ERROR}
      errorLabel="Copy failed — try again"
      getText={() => 'answer text'}
      icon={ICON}
      label="Copy answer"
      onCopied={onCopied}
    />,
  )
  return { ...view, writeTextMock }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('CopyAction', () => {
  it('names itself from the caller and morphs to the copied state on success', async () => {
    const onCopied = vi.fn()
    const { container } = renderCopy(() => Promise.resolve(), onCopied)
    const button = screen.getByRole('button', { name: 'Copy answer' })
    expect(button).toHaveAttribute('data-state', 'idle')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toHaveAttribute('data-state', 'copied'))
    expect(container.querySelector('[data-testid="copied-icon"]')?.parentElement).toHaveAttribute('data-on')
    expect(onCopied).toHaveBeenCalledWith('answer text')
  })

  it('lands in the error state when the clipboard refuses, and retries on the next click', async () => {
    const writeTextMock = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined)
    Object.assign(window.navigator, { clipboard: { writeText: writeTextMock } })
    render(
      <CopyAction
        copiedLabel="Copied"
        errorLabel="Copy failed — try again"
        getText={() => 'answer text'}
        icon={ICON}
        label="Copy answer"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed — try again' })).toHaveAttribute('data-state', 'error'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy failed — try again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toHaveAttribute('data-state', 'copied'))
    expect(writeTextMock).toHaveBeenCalledTimes(2)
  })

  it('writes once while a click is in flight', async () => {
    let resolveWrite: (() => void) | null = null
    const { writeTextMock } = renderCopy(() => new Promise<void>((resolve) => {
      resolveWrite = resolve
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    resolveWrite?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    expect(writeTextMock).toHaveBeenCalledTimes(1)
  })

  it('returns to idle after the copied state and clears its timer on unmount', () => {
    vi.useFakeTimers()
    const { container, unmount } = renderCopy(() => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    vi.advanceTimersByTime(1900)
    expect(container.querySelector('.agx-copy')).toHaveAttribute('data-state', 'idle')
    expect(() => unmount()).not.toThrow()
  })
})
