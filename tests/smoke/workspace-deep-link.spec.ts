import { expect, test } from '@playwright/test'

/**
 * A link decides first (ADR 0228): a Workspace registered through the API
 * after the page opened is opened by its link, in place and after a reload,
 * under the base path; a link to an unregistered id is abandoned safely.
 */
test('@smoke a link opens a Workspace registered through the API while the page is open', async ({ page, request }) => {
  test.setTimeout(180_000)
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const api = `${workspaceUrl}/api/v1`
  const stamp = Date.now()
  const registered: string[] = []
  const active = (name: string) => page.getByRole('button', { name: `Search ${name}`, exact: true })
  const create = async (path: string) => {
    const response = await request.post(`${api}/projects`, { data: { kind: 'create', path } })
    expect(response.ok()).toBeTruthy()
    const project = await response.json() as { id: string; name: string }
    registered.push(project.id)
    return project
  }
  try {
    const first = await create(`/tmp/kubecode-link-first-${stamp}`)
    await page.goto(`${workspaceUrl}/#/p/${first.id}/general`)
    await expect(page).toHaveURL(new RegExp(`#/p/${first.id}/general`))
    await expect(active(first.name)).toBeVisible({ timeout: 30_000 })

    // Registered through the API after the page loaded its Workspaces.
    const second = await create(`/tmp/kubecode-link-second-${stamp}`)
    await page.evaluate((hash) => { window.location.hash = hash }, `#/p/${second.id}/general`)
    await expect(active(second.name)).toBeVisible({ timeout: 15_000 })
    await expect(page).toHaveURL(new RegExp(`#/p/${second.id}/general`))

    // Back to the first, then a reload on a link to the second: the link wins over the remembered Workspace.
    await page.evaluate((hash) => { window.location.hash = hash }, `#/p/${first.id}/general`)
    await expect(active(first.name)).toBeVisible()
    await page.goto(`${workspaceUrl}/#/p/${second.id}/general`)
    await page.reload()
    await expect(active(second.name)).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`#/p/${second.id}/general`))

    // An unregistered id is abandoned: the address names where the researcher is.
    await page.evaluate(() => { window.location.hash = '#/p/not-a-registered-workspace/general' })
    await expect(page).toHaveURL(new RegExp(`#/p/${second.id}/`), { timeout: 15_000 })
    await expect(active(second.name)).toBeVisible()
  } finally {
    for (const id of registered) await request.delete(`${api}/projects/${id}`)
  }
})
