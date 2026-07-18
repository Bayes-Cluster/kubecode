import { afterEach, describe, expect, it, vi } from 'vitest'

import { KubecodeApi, apiBasePath } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('Kubecode API client', () => {
  it('keeps every request below the Kubeflow notebook prefix', () => {
    expect(apiBasePath('/user/alice/kubecode/')).toBe('/user/alice/kubecode/api/v1')
    expect(apiBasePath('/')).toBe('/api/v1')
  })

  it('encodes project ids and file paths independently', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: '', revision: '0' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.readFile('project/id', 'src/a file.ts')

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/projects/project%2Fid/file?path=src%2Fa+file.ts',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('surfaces structured server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'active_run', message: 'already running' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )))
    const api = new KubecodeApi('')

    await expect(api.listProjects()).rejects.toMatchObject({
      code: 'active_run',
      message: 'already running',
    })
  })

  it('starts an Agent run without a Kubecode permission mode', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'run-1',
      conversation_id: 'session-1',
      project_id: 'project-1',
      message: 'Do it',
      status: 'running',
      permission_mode: 'safe',
      error: null,
    })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.startRun('project-1', 'session-1', 'Do it')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/sessions/session-1/runs',
      expect.objectContaining({ body: JSON.stringify({ message: 'Do it' }) }),
    )
  })

  it('loads project run state for project icon activity', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('[]'))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.listProjectRuns('project/id')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project%2Fid/runs',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('loads bounded Session history below the notebook prefix', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runs: [],
      events: {},
      session_events: [],
      next_cursor: null,
    })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.getConversationHistory('session/1', 'run/51', 50)

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/sessions/session%2F1/history?before=run%2F51&limit=50',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('updates the project Workspaces preference with an explicit boolean', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'project-1',
      name: 'Demo',
      path: '/demo',
      workspaces_enabled: true,
    })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.setProjectWorkspacesEnabled('project/1', true)

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project%2F1/workspaces',
      expect.objectContaining({
        body: JSON.stringify({ enabled: true }),
        method: 'PATCH',
      }),
    )
  })

  it('requests an isolated workspace when creating an Agent session', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'session-1' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.createConversation('project-1', 'codex', undefined, undefined, undefined, 'worktree')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/sessions',
      expect.objectContaining({
        body: JSON.stringify({ agent_id: 'codex', workspace_mode: 'worktree' }),
        method: 'POST',
      }),
    )
  })

  it('creates a Team with an explicit Leader and workspace', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ team: { id: 'team-1' } })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.createTeam('project-1', 'codex', 'Lead', 'Investigate', 'worktree')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/teams',
      expect.objectContaining({
        body: JSON.stringify({
          agent_id: 'codex',
          leader_name: 'Lead',
          title: 'Investigate',
          workspace: 'worktree',
        }),
        method: 'POST',
      }),
    )
  })

  it('updates Team scheduling and resolves a lineup proposal', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ team: { id: 'team/1' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ team: { id: 'team/1' } })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.updateTeamSettings('team/1', 'auto', 4)
    await api.resolveTeamProposal('team/1', 'proposal/1', 'approved')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/teams/team%2F1/settings',
      expect.objectContaining({
        body: JSON.stringify({
          member_management_policy: 'auto',
          max_parallel_runs: 4,
        }),
        method: 'PATCH',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/teams/team%2F1/proposals/proposal%2F1/decision',
      expect.objectContaining({
        body: JSON.stringify({ decision: 'approved' }),
        method: 'POST',
      }),
    )
  })

  it('starts and explicitly completes a Team through its lifecycle API', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ team: { id: 'team-1', status: 'active' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ team: { id: 'team-1', status: 'completed' } })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.startTeam('team-1', {
      goal: 'Reproduce the experiment',
      acceptance_criteria: ['Tests pass'],
      allowed_agent_ids: ['codex', 'opencode'],
      mode: 'yolo',
      max_teammates: 3,
      max_parallel_runs: 2,
      max_review_rounds: 3,
    })
    await api.completeTeam('team-1', 'Integrated and verified')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/user/alice/kubecode/api/v1/teams/team-1/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          goal: 'Reproduce the experiment',
          acceptance_criteria: ['Tests pass'],
          allowed_agent_ids: ['codex', 'opencode'],
          mode: 'yolo',
          max_teammates: 3,
          max_parallel_runs: 2,
          max_review_rounds: 3,
        }),
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/user/alice/kubecode/api/v1/teams/team-1/complete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          final_summary: 'Integrated and verified',
        }),
      }),
    )
  })

  it('pauses, resumes, and directly intervenes in Team work', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      team: { id: 'team/1', status: 'active' },
    })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.pauseTeam('team/1')
    await api.resumeTeam('team/1')
    await api.assignTeamTask('team/1', 'task/1', 'member/1')
    await api.retryTeamTask('team/1', 'task/1')
    await api.cancelTeamTask('team/1', 'task/1', 'No longer needed')
    await api.removeTeamMember('team/1', 'member/1')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/teams/team%2F1/pause',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/teams/team%2F1/resume',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/teams/team%2F1/tasks/task%2F1/assign',
      expect.objectContaining({
        body: JSON.stringify({ member_id: 'member/1' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/v1/teams/team%2F1/tasks/task%2F1/retry',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      5,
      '/api/v1/teams/team%2F1/tasks/task%2F1/cancel',
      expect.objectContaining({
        body: JSON.stringify({ reason: 'No longer needed' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      6,
      '/api/v1/teams/team%2F1/members/member%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('previews and resolves the protected Workspaces migration', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        active_conversation_ids: [],
        worktrees: [{
          conversation_id: 'session-1',
          title: 'Agent work',
          path: '/state/worktrees/session-1',
          dirty: true,
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        project: { id: 'project-1', workspaces_enabled: false },
        exports: [],
      })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.getWorkspaceMigration('project-1')
    await api.migrateProjectWorkspaces('project-1', [{
      conversation_id: 'session-1',
      strategy: 'merge',
    }])

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/projects/project-1/workspaces/migration',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/projects/project-1/workspaces/migration',
      expect.objectContaining({
        body: JSON.stringify({
          resolutions: [{ conversation_id: 'session-1', strategy: 'merge' }],
        }),
        method: 'POST',
      }),
    )
  })

  it('creates an immutable Agent Chat branch at a run', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'branch-1' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.branchConversationAtRun('session/1', 'run/1')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/sessions/session%2F1/turns/run%2F1/branch',
      expect.objectContaining({ body: JSON.stringify({ restore_files: true }), method: 'POST' }),
    )
  })

  it('creates and lists hidden revisions without changing the Session id', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'revision-1' })))
      .mockResolvedValueOnce(new Response('[]'))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.reviseConversationAtRun('session/1', 'run/1')
    await api.listConversationRevisions('session/1')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/sessions/session%2F1/turns/run%2F1/revise',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/sessions/session%2F1/revisions',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('deletes a Session without a local-only scope', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.deleteConversation('session/1')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/sessions/session%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('creates a team member with an explicit shared or isolated workspace', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'member-1' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.createTeamMember('session-1', 'claude_code', false)

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/sessions/session-1/team-members',
      expect.objectContaining({
        body: JSON.stringify({ agent_id: 'claude_code', isolated: false }),
        method: 'POST',
      }),
    )
  })

  it('serializes Git diff booleans for Axum query parsing', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ diff: '' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.gitDiff('project-1', 'README.md', false)

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/git/diff?path=README.md&staged=false',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('loads the workspace cursor and manages global session summaries', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cursor: 42 })))
      .mockResolvedValueOnce(new Response('[]'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'session-1', archived: true })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await expect(api.workspaceEventCursor()).resolves.toBe(42)
    await api.listSessions()
    await api.archiveConversation('session/1', true)

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/events/cursor',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/sessions',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/sessions/session%2F1',
      expect.objectContaining({
        body: JSON.stringify({ archived: true }),
        method: 'PATCH',
      }),
    )
  })
})
