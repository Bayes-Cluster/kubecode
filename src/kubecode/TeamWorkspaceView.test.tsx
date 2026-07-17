import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TeamWorkspaceView } from './TeamWorkspaceView'
import type { KubecodeApi, TeamSnapshot } from './api'

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

  it('starts a draft Team only after goal, criteria, and autonomy are configured', async () => {
    const startTeam = vi.fn().mockResolvedValue({
      ...snapshot,
      team: { ...snapshot.team, status: 'active' },
    })
    render(
      <TeamWorkspaceView
        api={{
          getSessionState: vi.fn().mockResolvedValue({
            capabilities: null,
            available_commands: null,
            current_mode: null,
            config_options: null,
            plan: null,
            usage: null,
          }),
          listAgents: vi.fn().mockResolvedValue([
            { id: 'codex', available: true },
            { id: 'opencode', available: true },
            { id: 'claude_code', available: false },
          ]),
          startTeam,
        } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={{
          ...snapshot,
          team: {
            ...snapshot.team,
            status: 'draft',
            goal: '',
            acceptance_criteria: [],
            allowed_agent_ids: [],
          },
        }}
        t={t}
      />,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'OpenCode' })).toBeEnabled())
    fireEvent.change(screen.getByRole('textbox', { name: 'kubecode.teamGoal' }), {
      target: { value: 'Reproduce the experiment' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'kubecode.teamAcceptanceCriteria' }), {
      target: { value: 'Tests pass\nResults are documented' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }))
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.teamStart' }))

    expect(startTeam).toHaveBeenCalledWith('team-1', expect.objectContaining({
      goal: 'Reproduce the experiment',
      acceptance_criteria: ['Tests pass', 'Results are documented'],
      allowed_agent_ids: ['codex'],
      mode: 'standard',
    }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'kubecode.teamStart' }))
      .toHaveAttribute('aria-busy', 'false'))
  })

  it('forces the provider-native permission in YOLO while keeping model options editable', async () => {
    render(
      <TeamWorkspaceView
        api={{
          getSessionState: vi.fn().mockResolvedValue({
            capabilities: null,
            available_commands: null,
            current_mode: null,
            config_options: {
              configOptions: [
                {
                  type: 'select', id: 'mode', name: 'Mode', currentValue: 'agent',
                  options: [{ value: 'agent', name: 'Agent' }],
                },
                {
                  type: 'select', id: 'model', name: 'Model', currentValue: 'gpt-5.6',
                  options: [{ value: 'gpt-5.6', name: 'GPT-5.6' }],
                },
              ],
            },
            plan: null,
            usage: null,
          }),
          listAgents: vi.fn().mockResolvedValue([{ id: 'codex', available: true }]),
        } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={{
          ...snapshot,
          team: { ...snapshot.team, status: 'draft', requested_mode: 'yolo', mode: 'standard' },
        }}
        t={t}
      />,
    )

    expect(await screen.findByText('kubecode.teamYoloPermissionCodex')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'kubecode.agentMode' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument()
  })
})
