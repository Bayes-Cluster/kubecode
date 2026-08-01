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

describe('TeamSetupView', () => {
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
    const codexButton = screen.getByRole('button', { name: 'Codex' })
    const openCodeButton = screen.getByRole('button', { name: 'OpenCode' })
    expect(codexButton).toHaveAttribute('data-variant', 'default')
    expect(openCodeButton).toHaveAttribute('data-variant', 'default')
    fireEvent.change(screen.getByRole('textbox', { name: 'kubecode.teamGoal' }), {
      target: { value: 'Reproduce the experiment' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'kubecode.teamAcceptanceCriteria' }), {
      target: { value: 'Tests pass\nResults are documented' },
    })
    fireEvent.click(openCodeButton)
    expect(openCodeButton).toHaveAttribute('data-variant', 'outline')
    fireEvent.click(openCodeButton)
    expect(openCodeButton).toHaveAttribute('data-variant', 'default')
    fireEvent.click(openCodeButton)
    expect(openCodeButton).toHaveAttribute('data-variant', 'outline')
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

  it('keeps the OpenCode Build and Plan profile editable in YOLO', async () => {
    render(
      <TeamWorkspaceView
        api={{
          getSessionState: vi.fn().mockResolvedValue({
            capabilities: null,
            available_commands: null,
            current_mode: {
              currentModeId: 'build',
              availableModes: [
                { id: 'build', name: 'Build' },
                { id: 'plan', name: 'Plan' },
              ],
            },
            config_options: null,
            plan: null,
            usage: null,
          }),
          listAgents: vi.fn().mockResolvedValue([{ id: 'opencode', available: true }]),
        } as unknown as KubecodeApi}
        onSelectMember={vi.fn()}
        onSnapshotChange={vi.fn()}
        snapshot={{
          ...snapshot,
          leader_conversation: { ...snapshot.leader_conversation, agent_id: 'opencode' },
          team: { ...snapshot.team, status: 'draft', requested_mode: 'yolo', mode: 'standard' },
        }}
        t={t}
      />,
    )

    expect(await screen.findByRole('combobox', { name: 'kubecode.agentMode' })).toBeInTheDocument()
    expect(screen.queryByText('kubecode.teamYoloPermissionOpenCode')).not.toBeInTheDocument()
  })
})
