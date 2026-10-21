import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { closeNavigationSheet, expectUrl, toggleNavigation, workspaceNav } from './shell'

/**
 * The Workspace frame (#231, ADR 0234), against the real Runtime under a
 * non-root base path: General, Kanban, Resources, Needs you and Members share
 * one navigation and one header; Needs you is a place with an address that
 * Back returns to; the inspector is one 360-pixel column beside the view on a
 * desktop and the whole screen on a phone; nothing scrolls sideways.
 */

const DESTINATIONS = [
  { view: 'general', title: 'General', nav: 'General' },
  { view: 'board', title: 'Kanban', nav: /^Kanban/ },
  { view: 'resources', title: 'Resources', nav: 'Resources' },
  { view: 'needs-you', title: 'Needs you', nav: /^Needs you/ },
  { view: 'members', title: 'Members', nav: 'Members' },
] as const

function urls() {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  return { workspaceUrl, api: `${workspaceUrl}/api/v1` }
}

async function createWorkspace(request: APIRequestContext, api: string, name: string) {
  const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: `/tmp/${name}` } })
  expect(created.ok(), await created.text()).toBe(true)
  const projectId = (await created.json() as { id: string }).id
  await expect.poll(async () => {
    const roster = await (await request.get(`${api}/projects/${projectId}/members`)).json() as { members: Array<{ role: string }> }
    return roster.members.some((member) => member.role === 'general')
  }).toBe(true)
  return projectId
}

function header(page: Page, view: string) {
  return page.locator(`.kubecode-session-context-row header.kubecode-destination-header[data-destination="${view}"]`)
}

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
}

test.describe('the Workspace frame', () => {
  test('@smoke every destination shares one header, Needs you is a place, and the inspector is one column', async ({ page, request }) => {
    const { api, workspaceUrl } = urls()
    const projectId = await createWorkspace(request, api, `kubecode-frame-${Date.now()}`)
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
      await expect(header(page, 'general')).toBeVisible()
      const nav = workspaceNav(page)

      // One header per destination, at the same place, with no way "back".
      const tops: number[] = []
      for (const destination of DESTINATIONS) {
        await nav.getByRole('button', { name: destination.nav }).first().click()
        await expectUrl(page, `/user/local/kubecode/#/p/${projectId}/${destination.view}`)
        await expect(header(page, destination.view).getByRole('heading', { level: 2 })).toHaveText(destination.title)
        await expect(nav.getByRole('button', { name: destination.nav }).first()).toHaveAttribute('aria-current', 'page')
        await expect(header(page, destination.view).getByRole('button', { name: /^Back/ })).toHaveCount(0)
        tops.push(Math.round((await header(page, destination.view).boundingBox())!.y))
      }
      expect(new Set(tops).size).toBe(1)

      // Needs you is a place: Back returns to it, and a link opens it.
      await page.goBack()
      await expect(header(page, 'needs-you')).toBeVisible()
      await expect(page.getByRole('region', { name: 'Needs you', exact: true }).getByText('Nothing is waiting for you.')).toBeVisible()
      await page.reload()
      await expect(header(page, 'needs-you')).toBeVisible()

      // A member opens in the one inspector: a 360-pixel column beside Members.
      await nav.getByRole('button', { name: 'Members' }).click()
      await nav.getByRole('list', { name: 'Agents' }).getByRole('button', { name: /^General/ }).first().click()
      const aside = page.locator('aside.kubecode-inspector')
      await expect(aside).toBeVisible()
      expect(Math.round((await aside.boundingBox())!.width)).toBe(360)
      await expect(header(page, 'members')).toBeVisible()
      await expectContained(page)

      // On a phone the inspector is the screen, with Back to the view.
      await page.setViewportSize({ width: 390, height: 844 })
      await closeNavigationSheet(page)
      await expect(aside.getByRole('button', { name: 'Back to Members' })).toBeVisible()
      expect(Math.round((await aside.boundingBox())!.width)).toBe(390)
      await expectContained(page)
      await aside.getByRole('button', { name: 'Back to Members' }).click()
      await expect(aside).toHaveCount(0)

      // Every destination is readable at phone width, its header first.
      for (const destination of DESTINATIONS) {
        await toggleNavigation(page)
        await nav.getByRole('button', { name: destination.nav }).first().click()
        await closeNavigationSheet(page)
        await expect(header(page, destination.view)).toBeInViewport()
        await expectContained(page)
      }
    } finally {
      await request.delete(`${api}/projects/${projectId}`)
    }
  })
})
