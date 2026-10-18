import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TeamWorkspaceView } from './TeamWorkspaceView'
import type { KubecodeApi, TeamSnapshot } from './api'
import { boardOf, workApi, workCard } from './work/workFixtures'

const snapshot = {
  team: {
    id: 'team-1', project_id: 'p1', title: 'Compiler team', status: 'active', requested_mode: 'standard',
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

describe('TeamWorkspaceView', () => {
  it('shows a full-width task board without a separate member list', async () => {
    const selectMember = vi.fn()
    render(
      <TeamWorkspaceView
        api={workApi({
          workBoard: vi.fn().mockResolvedValue(boardOf([
            workCard({ id: 'task-1', title: 'Explore parser', origin: 'legacy_team', stage: 'ready', team_id: 'team-1' },
              { operable: 'legacy_team' }),
            workCard({ id: 'task-2', title: 'Review parser', origin: 'legacy_team', stage: 'review', team_id: 'team-1' },
              { operable: 'legacy_team', executor: { session_id: 'reviewer', title: 'Reviewer', agent_id: 'claude_code' } }),
          ])),
        }) as KubecodeApi}
        onSelectMember={selectMember}
        onSnapshotChange={vi.fn()}
        snapshot={snapshot}
        t={t}
      />,
    )

    expect(screen.getByText('1', { selector: '[data-metric="running"] strong' })).toBeInTheDocument()
    expect(await screen.findByText('Review parser')).toBeInTheDocument()
    expect(screen.queryByText('Explore', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('Review', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-member-rail')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/^work-column-/)).toHaveLength(6)
    expect(within(screen.getByTestId('work-column-review')).getByText('1')).toBeInTheDocument()
    expect(screen.getByText('Reviewer needs permission')).toBeInTheDocument()
    // A Team's task opens the Team's own dialog, which reaches the assignee's Session.
    fireEvent.click(screen.getByTestId('work-card-task-2'))
    fireEvent.click(await screen.findByRole('button', { name: 'kubecode.teamOpenSession' }))
    expect(selectMember).toHaveBeenCalledWith('reviewer')
    const activityTab = screen.getByRole('tab', { name: 'kubecode.teamActivity' })
    fireEvent.pointerDown(activityTab, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(activityTab)
    expect(activityTab).toHaveAttribute('data-state', 'active')
    expect(await screen.findByText('Delegated Review parser')).toBeInTheDocument()
  })
})
