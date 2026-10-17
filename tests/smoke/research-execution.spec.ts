import { expect, test, type Page } from '@playwright/test'

async function expectContained(page: Page) {
  const sizes = await page.evaluate(() => {
    const pane = document.querySelector('.kubecode-research-workspace')
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      paneClient: pane?.clientWidth ?? 0,
      paneScroll: pane?.scrollWidth ?? 0,
    }
  })
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth)
  expect(sizes.paneScroll).toBeLessThanOrEqual(sizes.paneClient + 1)
}

/**
 * A round runs deterministic local processes against the real Runtime under a
 * non-root base path: the researcher authorizes an envelope, sees a process
 * run and finish as "awaiting analysis" (never "analyzed"), reads its output
 * and artifact state, pauses future launches, stops a running process, and
 * closes the envelope. Backend failure modes (restart, ambiguous launch,
 * duplicate delivery) are covered by the server tests that own them.
 */
test('@smoke research execution shows processes, controls launches, and never calls a finished process analyzed', async ({ page, request }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const api = `${workspaceUrl}/api/v1`
  const projectName = `kubecode-exec-${Date.now()}`
  const projectPath = `/tmp/${projectName}`
  const title = 'Execution pilot'

  try {
    await page.goto(workspaceUrl)
    await page.getByRole('button', { name: 'Add project' }).click()
    await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
    await page.getByRole('option', { name: `Create ${projectPath}` }).click()
    await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible()
    const projects = await (await request.get(`${api}/projects`)).json() as Array<{ id: string; name: string }>
    const project = projects.find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('Project was not registered')
    const base = `${api}/projects/${encodeURIComponent(project.id)}/research`

    // Authorize one bounded round through the API, as the setup form would.
    const created = await request.post(base, {
      data: { title, question: 'Does the baseline hold?', client_request_id: `q-${Date.now()}` },
    })
    expect(created.ok()).toBe(true)
    const question = await created.json() as { id: string }
    const round = await (await request.post(`${base}/${question.id}/rounds`, {
      data: {
        client_request_id: `r-${Date.now()}`,
        expected_revision: 1,
        mode: 'solo',
        agent_id: 'opencode',
        instruction: 'Run the baseline.',
        envelope: {
          max_launches: 4,
          max_concurrent: 2,
          deadline_at: null,
          max_runtime_secs: 120,
          max_no_progress: 3,
          allowed_commands: [['sh', '-c']],
        },
      },
    })).json() as { id: string }
    const execution = `${base}/${question.id}/rounds/${round.id}/execution`
    const launch = (key: string, script: string, extra: Record<string, unknown> = {}) => request.post(
      `${execution}/experiments`,
      { data: { launch_key: key, argv: ['sh', '-c', script], label: key, ...extra } },
    )
    expect((await launch('baseline', 'echo hello-from-baseline; echo data > metrics.txt', { artifacts: ['metrics.txt'] })).ok()).toBe(true)
    expect((await launch('long', 'sleep 120')).ok()).toBe(true)

    await page.reload()
    await page.getByLabel('Research', { exact: true }).getByRole('button', { name: title }).click()
    await page.getByRole('tab', { name: 'Work' }).click()
    const section = page.locator('.kubecode-research-execution').first()
    await expect(section.getByRole('heading', { name: 'Execution' })).toBeVisible()
    await expect(section.getByText('Active', { exact: true })).toBeVisible()

    // The finished process is awaiting analysis, with its output and artifact.
    const baseline = section.getByRole('listitem').filter({ hasText: 'baseline' }).first()
    await expect(baseline).toContainText('Awaiting analysis', { timeout: 15_000 })
    await expect(baseline).not.toContainText('Analyzed')
    await baseline.getByRole('button', { name: 'View output' }).click()
    await expect(baseline.locator('pre').first()).toHaveText('hello-from-baseline\n')
    await expect(baseline.getByRole('list', { name: 'Artifacts' })).toContainText('metrics.txt')
    await expect(section).toContainText('result(s) still need analysis')

    // Pausing stops future launches and leaves the running process alone.
    await section.getByRole('button', { name: 'Pause launches' }).click()
    await expect(section.getByText('Paused', { exact: true })).toBeVisible()
    const refused = await launch('later', 'true')
    expect(refused.status()).toBe(409)
    expect((await refused.json() as { reason: string }).reason).toBe('envelope_paused')
    const long = section.getByRole('listitem').filter({ hasText: 'long' }).first()
    await expect(long).toContainText('Running')
    await section.getByRole('button', { name: 'Resume launches' }).click()
    await expect(section.getByText('Active', { exact: true })).toBeVisible()

    // Stop one process, then cancel the round's authority with a confirmation.
    await long.getByRole('button', { name: /^Stop/ }).click()
    await expect(long).toContainText('Cancelled', { timeout: 15_000 })
    await section.getByRole('button', { name: 'Cancel execution' }).click()
    await expect(section.getByRole('alertdialog')).toBeVisible()
    await section.getByRole('button', { name: 'Stop and close' }).click()
    await expect(section.getByText('Closed', { exact: true })).toBeVisible()
    const closed = await launch('after-close', 'true')
    expect((await closed.json() as { reason: string }).reason).toBe('envelope_closed')

    // The view converges after a reload and stays usable at phone width.
    await page.reload()
    await page.getByLabel('Research', { exact: true }).getByRole('button', { name: title }).click()
    await page.getByRole('tab', { name: 'Work' }).click()
    await expect(page.locator('.kubecode-research-execution').first().getByText('Closed', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expectContained(page)
  } finally {
    const projects = await request.get(`${api}/projects`)
    if (projects.ok()) {
      const registered = await projects.json() as Array<{ id: string; name: string }>
      const project = registered.find((candidate) => candidate.name === projectName)
      if (project) {
        await request.delete(`${api}/projects/${encodeURIComponent(project.id)}`)
      }
    }
  }
})
