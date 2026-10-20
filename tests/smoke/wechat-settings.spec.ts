import { expect, test, type Page } from '@playwright/test'

import { openExecutionHistory } from './shell'

// A tiny valid SVG standing in for the server-rendered QR image.
const QR_SVG = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>',
).toString('base64')}`

type Phase = 'disconnected' | 'waiting' | 'verify' | 'connected'

/**
 * Mocks only the WeChat iLink REST surface (the browser never talks to
 * Tencent); everything else — Projects, Sessions, events — is the real
 * Runtime under the configured non-root base path.
 */
async function mockIlink(page: Page) {
  const state: { phase: Phase; bound: string | null; verifyBodies: unknown[] } = {
    phase: 'disconnected',
    bound: null,
    verifyBodies: [],
  }
  const status = () => {
    const loginActive = state.phase === 'waiting' || state.phase === 'verify'
    return {
      status: {
        disconnected: 'disconnected',
        waiting: 'waiting_for_scan',
        verify: 'verification_required',
        connected: 'connected',
      }[state.phase],
      account_id: state.phase === 'connected' ? 'ilink_bot_smoke' : null,
      display_name: state.phase === 'connected' ? 'Smoke Bot' : null,
      bound_conversation_id: state.bound,
      login_active: loginActive,
      login_expires_in_ms: loginActive ? 240_000 : null,
      login_generation: loginActive ? 1 : null,
    }
  }
  const json = (body: unknown, status = 200) => ({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status,
  })
  await page.route('**/api/v1/ilink/status', (route) => route.fulfill(json(status())))
  await page.route('**/api/v1/ilink/login/qr', (route) => {
    state.phase = 'waiting'
    return route.fulfill(json({
      reused: false,
      qr_svg: QR_SVG,
      expires_in_ms: 300_000,
      generation: 1,
      status: 'waiting_for_scan',
    }))
  })
  await page.route('**/api/v1/ilink/login/qr/poll', (route) => {
    if (state.phase === 'waiting') state.phase = 'verify'
    return route.fulfill(json({ ...status(), qr_svg: state.phase === 'connected' ? null : QR_SVG }))
  })
  await page.route('**/api/v1/ilink/login/verify', (route) => {
    const body = route.request().postDataJSON() as { code: string; generation: number }
    state.verifyBodies.push(body)
    if (body.code !== '4829' || body.generation !== 1) {
      return route.fulfill(json({ code: 'ilink_invalid_state', message: 'stale' }, 409))
    }
    state.phase = 'connected'
    return route.fulfill(json({ accepted: true, status: 'connected' }))
  })
  await page.route('**/api/v1/ilink/session-binding', (route) => {
    const request = route.request()
    state.bound = request.method() === 'PUT'
      ? (request.postDataJSON() as { conversation_id: string }).conversation_id
      : null
    return route.fulfill(json({ bound_conversation_id: state.bound }))
  })
  await page.route('**/api/v1/ilink/quick-prompts', (route) => (
    route.fulfill(json({ slots: 9, max_chars: 2000, prompts: [] }))
  ))
  return state
}

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
  const dialog = await page.getByRole('dialog').first().boundingBox()
  if (!dialog) throw new Error('Settings dialog is not visible')
  expect(dialog.x).toBeGreaterThanOrEqual(0)
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(viewport.clientWidth + 1)
}

test('@smoke WeChat settings connect, verify, and bind on desktop and mobile', async ({ page, request }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const projectName = `kubecode-wechat-${Date.now()}`
  const projectPath = `/tmp/${projectName}`
  const sessionTitle = 'WeChat target'
  const ilink = await mockIlink(page)

  try {
    await page.goto(workspaceUrl)
    await page.getByRole('button', { name: 'Add project' }).click()
    await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
    await page.getByRole('option', { name: `Create ${projectPath}` }).click()
    await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible()
    const projects = await (await request.get(`${workspaceUrl}/api/v1/projects`)).json() as Array<{
      id: string
      name: string
    }>
    const project = projects.find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('Project was not registered')
    const created = await request.post(
      `${workspaceUrl}/api/v1/projects/${encodeURIComponent(project.id)}/sessions`,
      { data: { agent_id: 'opencode', title: sessionTitle } },
    )
    expect(created.ok()).toBe(true)
    const session = await created.json() as { id: string }
    await page.reload()

    // Connect: QR, verification against the live generation, connected.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'WeChat', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Not connected' })).toBeVisible()
    await page.getByRole('button', { name: 'Connect WeChat' }).click()
    await expect(page.getByRole('img', { name: 'QR code for linking WeChat to Kubecode' })).toBeVisible()
    await expect(page.getByText('Open WeChat, tap + and then Scan')).toBeVisible()
    const code = page.getByLabel('Verification code')
    await expect(code).toBeVisible({ timeout: 10_000 })
    await code.fill('4829')
    await page.getByRole('button', { name: 'Submit code' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({ timeout: 10_000 })
    expect(ilink.verifyBodies).toEqual([{ code: '4829', generation: 1 }])
    await expectContained(page)

    // Bind the Session from the selector; the sidebar marks it.
    await page.getByRole('combobox', { name: 'Active Session' }).click()
    await page.getByRole('option', { name: sessionTitle }).click()
    await expect.poll(() => ilink.bound).toBe(session.id)
    await expect(page.getByRole('combobox', { name: 'Active Session' })).toContainText(sessionTitle)
    await page.keyboard.press('Escape')
    // Sessions are execution history, one step away from the Workspace's places.
    await openExecutionHistory(page)
    await expect(page.getByRole('button', { name: `${sessionTitle}, active WeChat Session` })).toBeVisible()

    // Mobile width: the same section stays usable and contained.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'WeChat', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Active Session' })).toContainText(sessionTitle)
    await expectContained(page)
    // The browser never received anything to leak: no scan target or
    // identifiers beyond the rendered image.
    expect(await page.content()).not.toContain('ilink_bot_smoke')
  } finally {
    const projects = await request.get(`${workspaceUrl}/api/v1/projects`)
    if (projects.ok()) {
      const registered = await projects.json() as Array<{ id: string; name: string }>
      const project = registered.find((candidate) => candidate.name === projectName)
      if (project) {
        await request.delete(`${workspaceUrl}/api/v1/projects/${encodeURIComponent(project.id)}`)
      }
    }
  }
})
