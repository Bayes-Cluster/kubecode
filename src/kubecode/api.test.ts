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
})
