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

describe('TeamStatusView', () => {
  it('confirms an immediate Team pause and can resume a paused Team', async () => {
    const paused = { ...snapshot, team: { ...snapshot.team, status: 'paused' as const } }
    const pauseTeam = vi.fn().mockResolvedValue(paused)
    const resumeTeam = vi.fn().mockResolvedValue(snapshot)
    const onSnapshotChange = vi.fn()
    const { rerender } = render(
      <TeamWorkspaceView
        api={{ pauseTeam, resumeTeam } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={onSnapshotChange}
        snapshot={snapshot}
        t={t}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamPause' }))
    expect(screen.getByText('kubecode.teamPauseDescription')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamPauseConfirm' }))
    await waitFor(() => expect(pauseTeam).toHaveBeenCalledWith('team-1'))
    expect(onSnapshotChange).toHaveBeenCalledWith(paused)

    rerender(
      <TeamWorkspaceView
        api={{ pauseTeam, resumeTeam } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={onSnapshotChange}
        snapshot={paused}
        t={t}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamResume' }))
    await waitFor(() => expect(resumeTeam).toHaveBeenCalledWith('team-1'))
  })

  it('keeps an automatic YOLO fallback visible after hydration', () => {
    render(
      <TeamWorkspaceView
        api={{} as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={{
          ...snapshot,
          team: {
            ...snapshot.team,
            requested_mode: 'yolo',
            mode: 'standard',
            mode_fallback: {
              agent_id: 'claude_code',
              reason_code: 'native_permission_unavailable',
              reason: 'Host policy disabled bypassPermissions',
              occurred_at: '2026-07-17 18:00:00',
            },
          },
        }}
        t={t}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'kubecode.teamYoloFallback: Host policy disabled bypassPermissions',
    )
    expect(screen.getByText('kubecode.teamStandard')).toHaveAttribute('data-mode', 'standard')
  })

  it('shows the effective Team mode as a badge without runtime configuration limits', () => {
    render(
      <TeamWorkspaceView
        api={{} as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={snapshot}
        t={t}
      />,
    )

    expect(screen.getByText('kubecode.teamStandard')).toHaveClass('kubecode-team-mode-badge')
    expect(screen.getByText('kubecode.teamStandard')).toHaveAttribute('data-mode', 'standard')
    expect(screen.queryByText(/kubecode\.teamConcurrency/)).not.toBeInTheDocument()
    expect(screen.getByText('1', { selector: '[data-metric="running"] strong' })).toBeInTheDocument()
  })

  it('lets the user answer a durable Leader question inline', async () => {
    const updated = { ...snapshot, user_input_requests: [], attention: [] }
    const resolveTeamUserInput = vi.fn().mockResolvedValue(updated)
    const onSnapshotChange = vi.fn()
    render(
      <TeamWorkspaceView
        api={{ resolveTeamUserInput } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={onSnapshotChange}
        snapshot={{
          ...snapshot,
          team: { ...snapshot.team, status: 'needs_attention' },
          attention: [{
            id: 'input-1',
            kind: 'user_input',
            member_id: 'member-1',
            task_id: null,
            summary: 'Choose the evaluation dataset',
          }],
          user_input_requests: [{
            id: 'input-1',
            team_id: 'team-1',
            requester_member_id: 'member-1',
            title: 'Dataset choice',
            prompt: 'Choose the evaluation dataset',
            resume_status: 'active',
            status: 'pending',
            answer: null,
            created_at: '2026-07-17 10:00:00',
            resolved_at: null,
          }],
        }}
        t={t}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Dataset choice' }), {
      target: { value: 'Use the public benchmark' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamSubmitAnswer' }))

    await waitFor(() => expect(resolveTeamUserInput).toHaveBeenCalledWith(
      'team-1',
      'input-1',
      'Use the public benchmark',
    ))
    expect(onSnapshotChange).toHaveBeenCalledWith(updated)
  })
})
