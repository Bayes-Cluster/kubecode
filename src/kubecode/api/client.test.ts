import { afterEach, describe, expect, it, vi } from 'vitest'

import { KubecodeApi, apiBasePath, type RuntimeStatus } from '../api'

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

  it('lists Composer entries through the Session-scoped route below the configured base path', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('[]'))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')
    const controller = new AbortController()

    await api.listSessionEntries('session/id', 'src/a folder', controller.signal)

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/sessions/session%2Fid/entries?path=src%2Fa+folder',
      expect.objectContaining({
        headers: expect.any(Headers),
        signal: controller.signal,
      }),
    )
  })

  it('surfaces structured server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'agent_session_new_failed', message: 'failed', stage: 'session_new' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )))
    const api = new KubecodeApi('')

    await expect(api.listProjects()).rejects.toMatchObject({
      code: 'agent_session_new_failed',
      message: 'failed',
      stage: 'session_new',
    })
  })

  it('refreshes the shared Agent catalog explicitly', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('[]'))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.refreshAgents()

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/agents/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('loads typed Runtime status below the configured base path', async () => {
    const response: RuntimeStatus = {
      active_actor_count: 2,
      idle_actor_count: 3,
      warm_actor_limit: 4,
      latest_workspace_event_cursor: 91,
      workspace_event_delivery_available: true,
    }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    const status: RuntimeStatus = await api.runtimeStatus()

    expect(status).toEqual(response)
    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/runtime/status',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
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

  it('uses Session-scoped context routes and opaque structured segments below the base path', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')
    const reference = {
      id: 'ctx:opaque',
      catalog_revision: 7,
      context_kind: 'file' as const,
    }

    await api.registerComposerContext('session/id', { kind: 'file', path: 'src/main.ts' })
    await api.validateComposerContexts('session/id', [reference])
    await api.startStructuredRun('project/id', 'session/id', {
      catalog_revision: 8,
      segments: [{ kind: 'context_ref', ...reference }],
    })

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/user/alice/kubecode/api/v1/sessions/session%2Fid/composer/contexts',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'file', path: 'src/main.ts' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/user/alice/kubecode/api/v1/sessions/session%2Fid/composer/contexts/validate',
      expect.objectContaining({
        body: JSON.stringify({ references: [reference] }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/user/alice/kubecode/api/v1/projects/project%2Fid/sessions/session%2Fid/runs',
      expect.objectContaining({
        body: JSON.stringify({
          catalog_revision: 8,
          segments: [{ kind: 'context_ref', ...reference }],
        }),
        method: 'POST',
      }),
    )
  })

  it('discovers and registers versioned Git diff context without sending diff content', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/workspace')
    const revision = 'a'.repeat(64)

    await api.listComposerGitDiffs('session/id')
    await api.registerComposerContext('session/id', {
      kind: 'git_diff', path: '.', source_revision: revision,
    })

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/workspace/api/v1/sessions/session%2Fid/composer/git-diffs',
      expect.not.objectContaining({ body: expect.anything() }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/workspace/api/v1/sessions/session%2Fid/composer/contexts',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'git_diff', path: '.', source_revision: revision }),
        method: 'POST',
      }),
    )
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('diff --git')
  })

  it('dispatches an advertised ACP command through the dedicated endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'run-1' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.dispatchAcpCommand('project/id', 'session/id', 'review', 'security')

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/projects/project%2Fid/sessions/session%2Fid/commands',
      expect.objectContaining({
        body: JSON.stringify({ name: 'review', arguments: 'security' }),
        method: 'POST',
      }),
    )
  })

  it('dispatches a palette command by opaque catalog coordinates below the base path', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'run-1' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.dispatchComposerCommand('project/id', 'session/id', 'cmd:opaque', 12, '')

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/projects/project%2Fid/sessions/session%2Fid/commands',
      expect.objectContaining({
        body: JSON.stringify({ item_id: 'cmd:opaque', catalog_revision: 12, arguments: '' }),
        method: 'POST',
      }),
    )
  })

  it('sends a Claude side question through the Session extension endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'side-1',
      status: 'pending',
    })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.askSideQuestion('session/1', 'What are you doing?')

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/sessions/session%2F1/side-questions',
      expect.objectContaining({
        body: JSON.stringify({ question: 'What are you doing?' }),
        method: 'POST',
      }),
    )
  })

  it('creates a terminal in an optional Session execution context', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'terminal-1' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.createTerminal('project/1', 'regular', 100, 28, 'session/1')

    expect(fetch).toHaveBeenCalledWith(
      '/user/alice/kubecode/api/v1/projects/project%2F1/terminals',
      expect.objectContaining({
        body: JSON.stringify({
          kind: 'regular',
          cols: 100,
          rows: 28,
          conversation_id: 'session/1',
        }),
        method: 'POST',
      }),
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

  it('serializes Git diff booleans and forwards an abort signal for Axum query parsing', async () => {
    const result = { diff: null, unavailable_reason: 'binary' as const }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')
    const controller = new AbortController()

    await expect(
      api.gitDiff('project-1', 'README.md', false, controller.signal),
    ).resolves.toEqual(result)

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/git/diff?path=README.md&staged=false',
      expect.objectContaining({
        headers: expect.any(Headers),
        signal: controller.signal,
      }),
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

  it('lists directories and creates, imports, and unregisters Projects', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.listDirectories('src')
    await api.createProject('/tmp/foo')
    await api.importProject('/tmp/bar')
    await api.unregisterProject('project/1')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/filesystem/directories?path=src',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/projects',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'create', path: '/tmp/foo' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/projects',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'import', path: '/tmp/bar' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/v1/projects/project%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('manages file entries through CRUD routes below the base path', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.listEntries('project/1', 'src')
    await api.createEntry('project/1', 'src/readme.md', 'file')
    await api.renameEntry('project/1', 'a.ts', 'b.ts')
    await api.deleteEntry('project/1', 'src/old.ts')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/user/alice/kubecode/api/v1/projects/project%2F1/entries?path=src',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/user/alice/kubecode/api/v1/projects/project%2F1/entries',
      expect.objectContaining({
        body: JSON.stringify({ path: 'src/readme.md', kind: 'file' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/user/alice/kubecode/api/v1/projects/project%2F1/entries',
      expect.objectContaining({
        body: JSON.stringify({ from: 'a.ts', to: 'b.ts' }),
        method: 'PATCH',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/user/alice/kubecode/api/v1/projects/project%2F1/entries?path=src%2Fold.ts',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('writes a file with an optimistic revision', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: 'x' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.writeFile('project-1', 'README.md', 'hello', 'rev-3')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/file?path=README.md',
      expect.objectContaining({
        body: JSON.stringify({ content: 'hello', revision: 'rev-3' }),
        method: 'PUT',
      }),
    )
  })

  it('reads Git status and drives Git init, mutate, and commit', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.gitStatus('project-1')
    await api.initializeGit('project-1')
    await api.mutateGit('project-1', 'stage', ['README.md'])
    await api.commitGit('project-1', 'feat: split API client')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/projects/project-1/git/status',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/projects/project-1/git/init',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/projects/project-1/git/mutate',
      expect.objectContaining({
        body: JSON.stringify({ action: 'stage', paths: ['README.md'] }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/v1/projects/project-1/git/commit',
      expect.objectContaining({
        body: JSON.stringify({ message: 'feat: split API client' }),
        method: 'POST',
      }),
    )
  })

  it('lists Agents and Session summaries at the project and global scopes', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.listAgents()
    await api.listConversations('project-1')
    await api.listProviderSessions('project/1', 'codex')

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/agents', expect.any(Object))
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/projects/project-1/sessions',
      expect.any(Object),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/projects/project%2F1/agents/codex/sessions',
      expect.any(Object),
    )
  })

  it('creates a Session with optional context only when supplied', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'session-1' })))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.createConversation('project-1', 'opencode', 'Work')

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/sessions',
      expect.objectContaining({
        body: JSON.stringify({ agent_id: 'opencode', title: 'Work' }),
        method: 'POST',
      }),
    )
  })

  it('loads a single Team snapshot and resolves a user input request', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      team: { id: 'team-1' },
    }))))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('/user/alice/kubecode')

    await api.listTeams('project-1')
    await api.getTeam('team/1')
    await api.resolveTeamUserInput('team/1', 'request/1', 'yes')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/user/alice/kubecode/api/v1/projects/project-1/teams',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/user/alice/kubecode/api/v1/teams/team%2F1',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/user/alice/kubecode/api/v1/teams/team%2F1/attention/request%2F1/resolve',
      expect.objectContaining({
        body: JSON.stringify({ answer: 'yes' }),
        method: 'POST',
      }),
    )
  })

  it('promotes, renames, forks, and renames a Session', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.promoteToTeam('session/1', 'Lead', 'Title')
    await api.updateConversation('session/1', 'Manual title')
    await api.forkConversation('session/1')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/sessions/session%2F1/promote-to-team',
      expect.objectContaining({
        body: JSON.stringify({ leader_name: 'Lead', title: 'Title' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/sessions/session%2F1',
      expect.objectContaining({
        body: JSON.stringify({ manual_title: 'Manual title' }),
        method: 'PATCH',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/sessions/session%2F1/fork',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('loads runs, events, and Session state through their dedicated routes', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.listRuns('session/1')
    await api.getRun('run/1')
    await api.listEvents('run/1', 5)
    await api.listSessionEvents('session/1', 6)
    await api.getSessionState('session/1')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/sessions/session%2F1/runs',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/runs/run%2F1',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/runs/run%2F1/events?after=5',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/v1/sessions/session%2F1/events?after=6',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      5,
      '/api/v1/sessions/session%2F1/state',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('updates Session mode and config options', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.setSessionMode('session/1', 'plan')
    await api.setSessionConfig('session/1', 'max-turns', false)

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/sessions/session%2F1/options',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'mode', value: 'plan' }),
        method: 'PATCH',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/sessions/session%2F1/options',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'config', config_id: 'max-turns', value: false }),
        method: 'PATCH',
      }),
    )
  })

  it('builds event stream URLs below the configured base path', () => {
    const api = new KubecodeApi('/user/alice/kubecode')

    expect(api.eventStreamUrl('run/1', 7)).toBe(
      '/user/alice/kubecode/api/v1/runs/run%2F1/events/stream?after=7',
    )
    expect(api.workspaceEventStreamUrl(9)).toBe(
      '/user/alice/kubecode/api/v1/events?after=9',
    )
  })

  it('cancels a run and resolves permission and elicitation requests', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const api = new KubecodeApi('')

    await api.cancelRun('run/1')
    await api.resolvePermission('permission/1', 'option/1')
    await api.resolveElicitation('elicitation/1', { answer: 'yes' })

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/runs/run%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/permissions/permission%2F1',
      expect.objectContaining({
        body: JSON.stringify({ option_id: 'option/1' }),
        method: 'POST',
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/elicitations/elicitation%2F1',
      expect.objectContaining({
        body: JSON.stringify({ content: { answer: 'yes' } }),
        method: 'POST',
      }),
    )
  })

  it('lists, closes, and renames Terminals and opens their socket', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')))
    vi.stubGlobal('fetch', fetch)
    class MockWebSocket {
      constructor(public url: string) {}
    }
    vi.stubGlobal('WebSocket', MockWebSocket)
    const api = new KubecodeApi('')

    await api.listTerminals('project/1')
    await api.closeTerminal('terminal/1')
    await api.updateTerminal('terminal/1', 'Runtime')

    const socket = api.terminalSocket('project/1', 'terminal/1', 3)

    expect(socket).toBeInstanceOf(MockWebSocket)
    expect(socket.url).toBe(
      `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/v1/projects/project%2F1/terminals/terminal%2F1/attach?cursor=3`,
    )
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/projects/project%2F1/terminals',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/terminals/terminal%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/terminals/terminal%2F1',
      expect.objectContaining({
        body: JSON.stringify({ title: 'Runtime' }),
        method: 'PATCH',
      }),
    )
  })

  it('falls back to a generic ApiError when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 502 })))
    const api = new KubecodeApi('')

    await expect(api.listProjects()).rejects.toMatchObject({
      code: 'request_failed',
      message: 'Request failed (502)',
      status: 502,
    })
  })
})
