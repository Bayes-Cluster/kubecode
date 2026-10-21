import { expect, test } from '@playwright/test'

/**
 * Regressions found by the #229 integrated acceptance walkthrough (fixture
 * validation, no real provider): an empty General is the prototype's empty
 * state, a dropped connection is reported in the interface language, and the
 * document declares the language the interface speaks.
 */
function urls() {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/' ? `${requested.origin}/user/local/kubecode` : requested.href.replace(/\/$/, '')
  return { workspaceUrl, api: `${workspaceUrl}/api/v1` }
}

test.describe('in German', () => {
  test.use({ hasTouch: false, locale: 'de-DE', viewport: { width: 1440, height: 900 } })

  test('@smoke an empty General, a dropped send and the document language follow the interface language', async ({ page, request }) => {
    const { api, workspaceUrl } = urls()
    const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: `/tmp/kubecode-acceptance-${Date.now()}` } })
    expect(created.ok(), await created.text()).toBe(true)
    const projectId = (await created.json() as { id: string }).id
    try {
      await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
      await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
      await expect(page.locator('.kubecode-conversation-empty')).toBeVisible()

      let aborted = false
      await page.route('**/channels/*/messages', async (route) => {
        if (route.request().method() === 'POST' && !aborted) {
          aborted = true
          await route.abort()
          return
        }
        await route.continue()
      })
      const composer = page.locator('[data-focus-key="composer:general"]')
      await composer.fill('Hallo')
      await composer.press('Enter')
      const alert = page.locator('.kubecode-outbox-failure')
      await expect(alert).toBeVisible()
      await expect(alert).not.toContainText('Failed to fetch')
    } finally {
      await request.delete(`${api}/projects/${projectId}`)
    }
  })
})
