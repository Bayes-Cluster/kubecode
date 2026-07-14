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
})
