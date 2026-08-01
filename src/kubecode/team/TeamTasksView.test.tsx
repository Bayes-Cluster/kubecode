import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TeamWorkspaceView } from '../TeamWorkspaceView'
import type { KubecodeApi, TeamSnapshot } from '../api'

const snapshot = {
  team: {
    id: 'team-1', title: 'Compiler team', status: 'active', requested_mode: 'standard',
    mode: 'standard', mode_fallback: null,
    member_management_policy: 'ask', max_parallel_runs: 3, max_teammates: 3,
    max_review_rounds: 3, current_review_round: 0, goal: 'Fix the compiler',
    acceptance_criteria: ['Tests pass'], allowed_agent_ids: ['codex', 'claude_code'],
  },
  leader_conversation: { id: 'leader', title: 'Compiler team', agent_id: 'codex' },
  conversations: [
    { id: 'leader', agent_id: 'codex' },
    { id: 'reviewer', agent_id: 'claude_code' },
  ],
  members: [
    { id: 'member-1', conversation_id: 'leader', name: 'Lead', role: 'leader', status: 'working' },
    { id: 'member-2', conversation_id: 'reviewer', name: 'Reviewer', role: 'teammate', status: 'waiting_permission' },
  ],
  tasks: [
    { id: 'task-1', title: 'Explore parser', description: 'Explore', status: 'pending', assignee_member_id: null, dependencies: [] },
    { id: 'task-2', title: 'Review parser', description: 'Review', status: 'result_review', assignee_member_id: 'member-2', dependencies: ['task-1'] },
  ],
  summary: { running: 1, queued: 0, needs_attention: 2, done: 0, total_tasks: 2 },
  proposal: null,
  activity: [{
    id: 1, team_id: 'team-1', member_id: 'member-2', task_id: 'task-2',
    kind: 'task_delegated', summary: 'Delegated Review parser', metadata_json: null,
    created_at: '2026-07-17 10:00:00',
  }],
  attention: [{
    id: 'member:member-2:waiting_permission', kind: 'waiting_permission',
    member_id: 'member-2', task_id: null, summary: 'Reviewer needs permission',
  }],
  discrimination_rounds: [],
} as TeamSnapshot

const t = ((key: string) => key) as never

describe('TeamTasksView', () => {
  it('keeps unassigned tasks visually explicit without rendering roster-only members', () => {
    render(
      <TeamWorkspaceView
        api={{} as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={snapshot}
        t={t}
      />,
    )

    expect(screen.getByTestId('team-task-card-task-1')).toHaveTextContent('—')
    expect(screen.queryByText('Lead')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reviewer' })).toBeInTheDocument()
  })

  it('opens task details in a centered modal and can assign a teammate', async () => {
    const updated = {
      ...snapshot,
      tasks: [{ ...snapshot.tasks[0], assignee_member_id: 'member-2', status: 'in_progress' }],
    }
    const assignTeamTask = vi.fn().mockResolvedValue(updated)
    render(
      <TeamWorkspaceView
        api={{ assignTeamTask } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={snapshot}
        t={t}
      />,
    )

    fireEvent.click(screen.getByTestId('team-task-card-task-1'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Explore parser')
    expect(dialog).toHaveClass('kubecode-team-task-dialog')
    expect(dialog).not.toHaveClass('kubecode-team-inspector')
    fireEvent.click(screen.getByRole('combobox', { name: 'kubecode.teamTaskAssign' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Reviewer' }))
    await waitFor(() => expect(assignTeamTask).toHaveBeenCalledWith(
      'team-1',
      'task-1',
      'member-2',
    ))
  })

  it('requires confirmation before cancelling a task', async () => {
    const cancelTeamTask = vi.fn().mockResolvedValue(snapshot)
    render(
      <TeamWorkspaceView
        api={{ cancelTeamTask } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={snapshot}
        t={t}
      />,
    )

    fireEvent.click(screen.getByTestId('team-task-card-task-1'))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamTaskCancel' }))
    expect(cancelTeamTask).not.toHaveBeenCalled()
    expect(screen.getByText('kubecode.teamTaskCancelDescription')).toBeInTheDocument()
    const confirmation = screen.getAllByRole('dialog').at(-1)
    expect(confirmation).toBeDefined()
    fireEvent.click(within(confirmation as HTMLElement).getByRole('button', {
      name: 'kubecode.teamTaskCancel',
    }))
    await waitFor(() => expect(cancelTeamTask).toHaveBeenCalledWith(
      'team-1',
      'task-1',
    ))
  })

  it('allows a cancelled task to be retried', async () => {
    const retryTeamTask = vi.fn().mockResolvedValue(snapshot)
    render(
      <TeamWorkspaceView
        api={{ retryTeamTask } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={{
          ...snapshot,
          tasks: snapshot.tasks.map((task) => ({
            ...task,
            status: 'cancelled' as const,
            completion_required: false,
          })),
        }}
        t={t}
      />,
    )

    fireEvent.click(screen.getByTestId('team-task-card-task-1'))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamTaskRetry' }))

    await waitFor(() => expect(retryTeamTask).toHaveBeenCalledWith('team-1', 'task-1'))
  })
})
