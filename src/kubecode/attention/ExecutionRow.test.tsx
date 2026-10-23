import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import { execution } from './attentionFixtures'
import { ExecutionRow } from './ExecutionRow'

const t = createTranslator('en')

function row(props: Partial<Parameters<typeof ExecutionRow>[0]> = {}) {
  const run = execution()
  render(
    <ul>
      <ExecutionRow entryKey="task:r1" runs={[run]} stopping={false} t={t} task={run.tasks[0]} onStop={vi.fn()} {...props} />
    </ul>,
  )
  return screen.getByRole('listitem')
}

describe('ExecutionRow', () => {
  it('names the member once, with the Task on its own line, and never repeats the name in the status', () => {
    const item = row()
    expect(within(item).getAllByText('Analyst')).toHaveLength(1)
    const title = item.querySelector('.kubecode-execution-title') as HTMLElement
    expect(title).toHaveTextContent('Structured pruning')
    expect(title).toHaveAttribute('title', 'Structured pruning')
    expect(item).not.toHaveTextContent(/Analyst is/)
  })

  it('keeps a member name on one line in a narrow strip instead of breaking it letter by letter (#263)', () => {
    const item = row()
    const identity = item.querySelector('.kubecode-member-identity') as HTMLElement
    expect(identity).toHaveClass('whitespace-nowrap', 'min-w-0', 'truncate')
  })

  it('shows queued messages as a small count', () => {
    const item = row({ runs: [execution({ queued: 3 })] })
    expect(within(item).getByText('3 queued')).toHaveClass('kubecode-execution-queued')
  })

  it('has no queued count when nothing waits', () => {
    expect(row()).not.toHaveTextContent(/queued/)
  })

  it('says Stop task for a Task and Stop reply for a reply, keeping the full name accessible', () => {
    const item = row()
    const stop = within(item).getByRole('button', { name: 'Stop Structured pruning' })
    expect(stop).toHaveTextContent('Stop task')
  })

  it('says Replying and Stop reply for a reply that belongs to no Task', () => {
    const item = row({ entryKey: 'run:run1', runs: [execution({ tasks: [] })], task: null })
    expect(item.querySelector('.kubecode-execution-title')).toHaveTextContent('Replying')
    expect(within(item).getByRole('button', { name: "Stop Analyst's reply" })).toHaveTextContent('Stop reply')
  })

  it('says a wait plainly, without the member\'s name', () => {
    const item = row({ runs: [execution({ status: 'waiting_permission', waiting_keys: ['k'] })] })
    expect(item).toHaveTextContent('Waiting for your permission')
    expect(item).not.toHaveTextContent(/Analyst is waiting/)
  })
})
