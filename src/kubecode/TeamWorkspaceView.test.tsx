import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TeamWorkspaceView } from './TeamWorkspaceView'
import type { KubecodeApi, TeamSnapshot } from './api'

const snapshot = {
  team: {
    id: 'team-1', title: 'Compiler team', member_management_policy: 'ask', max_parallel_runs: 3,
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
} as TeamSnapshot

const t = ((key: string) => key) as never

describe('TeamWorkspaceView', () => {
  it('shows a full-width task board without a separate member list', async () => {
    const selectMember = vi.fn()
    render(
      <TeamWorkspaceView
        api={{} as KubecodeApi}
        onSelectMember={selectMember}
        onSnapshotChange={vi.fn()}
        snapshot={snapshot}
        t={t}
      />,
    )

    expect(screen.getByText('1', { selector: '[data-metric="running"] strong' })).toBeInTheDocument()
    expect(screen.getByText('Review parser')).toBeInTheDocument()
    expect(screen.queryByText('Explore', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('Review', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-member-rail')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/^team-board-column-/)).toHaveLength(5)
    expect(within(screen.getByTestId('team-board-column-review')).getByText('1')).toBeInTheDocument()
    expect(screen.getByText('Reviewer needs permission')).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('team-task-card-task-2')).getByRole('button', {
      name: 'Reviewer',
    }))
    expect(selectMember).toHaveBeenCalledWith('reviewer')
    const activityTab = screen.getByRole('tab', { name: 'kubecode.teamActivity' })
    fireEvent.pointerDown(activityTab, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(activityTab)
    expect(activityTab).toHaveAttribute('data-state', 'active')
    expect(await screen.findByText('Delegated Review parser')).toBeInTheDocument()
  })

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

  it('persists automatic member management through the Team API', async () => {
    const updateTeamSettings = vi.fn().mockResolvedValue({
      ...snapshot,
      team: { ...snapshot.team, member_management_policy: 'auto' },
    })
    render(
      <TeamWorkspaceView
        api={{ updateTeamSettings } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={snapshot}
        t={t}
      />,
    )

    fireEvent.click(screen.getByRole('switch', { name: 'kubecode.teamAutoManage' }))
    expect(updateTeamSettings).toHaveBeenCalledWith('team-1', 'auto', 3)
  })
})
