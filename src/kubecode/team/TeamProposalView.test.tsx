import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('TeamProposalView', () => {
  it('lets the user approve a durable lineup proposal', async () => {
    const updated = { ...snapshot, proposal: null }
    const resolveTeamProposal = vi.fn().mockResolvedValue(updated)
    const onSnapshotChange = vi.fn()
    render(
      <TeamWorkspaceView
        api={{ resolveTeamProposal } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={onSnapshotChange}
        snapshot={{
          ...snapshot,
          proposal: {
            id: 'proposal-1',
            team_id: 'team-1',
            summary: 'Use a reviewer and an implementer',
            members_json: JSON.stringify([{ name: 'Reviewer' }, { name: 'Implementer' }]),
            status: 'pending',
            created_at: '2026-07-18 10:00:00',
            resolved_at: null,
          },
        }}
        t={t}
      />,
    )

    expect(screen.getByTestId('team-lineup-proposal')).toHaveTextContent('Reviewer')
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamProposalApprove' }))
    await waitFor(() => expect(resolveTeamProposal).toHaveBeenCalledWith(
      'team-1',
      'proposal-1',
      'approved',
    ))
    expect(onSnapshotChange).toHaveBeenCalledWith(updated)
  })
})
