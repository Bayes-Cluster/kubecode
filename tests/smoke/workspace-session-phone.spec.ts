import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { closeNavigationSheet, openExecutionHistory } from './shell'

/**
 * #307: the Session workspace must survive the phone width. The slice-L
 * walkthrough lost the renderer here twice (a fresh 390 page and the busy
 * desktop page resized down alike); the composer presentation was rebuilt
 * since (#308) and this keeps the surface honest: a Session opened at
 * 390×844 mounts its composer, stays within the viewport, and survives the
 * desktop→phone resize in both directions. The queue dock and plan rail
 * inside the session column have their own behavioural suites — this one
 * guards the width, where the renderer used to die.
 */

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  function urls() {
    const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
    const workspaceUrl = requested.pathname === '/'
      ? `${requested.origin}/user/local/kubecode`
      : requested.href.replace(/\/$/, '')
    return { workspaceUrl, api: `${workspaceUrl}/api/v1` }
  }

  async function expectContained(page: Page) {
    const viewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
  }

  async function createProject(request: APIRequestContext, api: string, name: string): Promise<string> {
    const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: `/tmp/${name}` } })
    expect(created.ok(), await created.text()).toBe(true)
    return (await created.json() as { id: string }).id
  }

  test('@smoke a Session opens at 390, stays contained, and survives the desktop resize', async ({ page, request }) => {
    test.setTimeout(180_000)
    const { workspaceUrl, api } = urls()
    const name = `kubecode-session-phone-${Date.now()}`
    const projectId = await createProject(request, api, name)
    try {
      // The Sessions surface lives on the workspace root; at the phone
      // width the navigator is the Sheet.
      await page.goto(workspaceUrl)
      await closeNavigationSheet(page)
      await page.getByRole('button', { name: 'Toggle navigation' }).click()
      const history = await openExecutionHistory(page)
      await history.getByRole('button', { name: 'New session' }).click()
      await page.getByRole('combobox', { name: 'Agent' }).click()
      await page.getByRole('option', { name: 'OpenCode' }).click()
      await page.getByRole('textbox', { name: 'Session title' }).fill('Phone width')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      // The Sheet stays open over the new Session; the aria-modal dialog
      // hides the rest of the tree until it closes. The Session view's own
      // chrome has no navigation toggle, so close it directly.
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Workspaces' })).toBeHidden()

      const surface = page.getByTestId('agent-composer-surface')
      await expect(surface).toBeVisible({ timeout: 20_000 })
      // CSS, not the role query: the closed Sheet's aria-modal keeps pruning
      // the surrounding tree for a while after it hides.
      await expect(surface.locator('button[aria-label="Send message"]')).toBeVisible()
      await expectContained(page)

      // The walkthrough's method: the busy page resized down from the
      // desktop, then back — the renderer must live through both.
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(surface).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(surface).toBeVisible()
      await expectContained(page)
      expect(page.isClosed()).toBe(false)
    } finally {
      await request.delete(`${api}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
