import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { waitForPrompt } from './agents'
import { closeNavigationSheet, inspector, workspaceNav } from './shell'
import { seedTaskInReview } from './taskFixtures'

/**
 * What waits on the researcher, against the real Runtime (#220, ADR 0232):
 * one pending decision is one Needs-you row, however many records refer to
 * it; the row opens the context that holds it, and answering it there clears
 * Needs you, the bell and the prompt once the server acknowledges it. Sending
 * stays possible while a member waits; each Task or reply has one Stop; delivery
 * lines say only what the server proved; a failed send keeps its words and is
 * sent once. The member asking permission is the deterministic fixture
 * provider (`[smoke:permission]`); no real agent runs.
 */

type Roster = { members: Array<{ id: string; name: string; handle: string; role: string; public_conversation_id: string | null }> }

function urls() {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  return { workspaceUrl, api: `${workspaceUrl}/api/v1` }
}

async function roster(request: APIRequestContext, api: string, projectId: string): Promise<Roster> {
  return (await (await request.get(`${api}/projects/${projectId}/members`)).json()) as Roster
}

const composer = (page: Page) => page.getByRole('combobox', { name: 'Message the Workspace' })
const log = (page: Page) => page.getByRole('log', { name: 'Messages' })
const row = (page: Page, text: string) => page.locator('article[data-message-id]').filter({ hasText: text })
const needsYouView = (page: Page) => page.getByRole('region', { name: 'Needs you', exact: true })
const decisions = (page: Page) => needsYouView(page).getByRole('list', { name: 'Decisions' })
/** The navigation's Needs you place, with its count of what waits. */
const needsYouPlace = (page: Page) => workspaceNav(page).getByRole('button', { name: /^Needs you/ })

/** Needs you is a destination of its own (ADR 0234): its header, its address, its list. */
async function openNeedsYou(page: Page) {
  await needsYouPlace(page).click()
  await expect.poll(() => page.url()).toMatch(/\/needs-you$/)
  await expect(needsYouView(page).getByRole('heading', { name: 'Needs you', level: 2 })).toBeVisible()
}
const strip = (page: Page) => page.getByRole('region', { name: 'Working now' })

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(log(page).getByText(text, { exact: true })).toBeVisible()
}

/** Nothing waits: the navigation counts a quiet zero. */
async function nothingWaits(page: Page) {
  await expect(needsYouPlace(page).locator('.kubecode-research-badge')).toHaveText('0', { timeout: 20_000 })
  await expect(needsYouPlace(page).locator('.kubecode-research-badge')).toHaveAttribute('data-tone', 'muted')
}

test.describe('on a desktop', () => {
  test.use({ hasTouch: false })

  test('@smoke Needs you lists each decision once, opens where it is answered, and clears everywhere after the answer', async ({ page, request }) => {
    test.setTimeout(360_000)
    const { api, workspaceUrl } = urls()
    const stamp = Date.now()
    const registered: string[] = []
    try {
      // Another Workspace with a Task waiting for review: the bell counts it too.
      const reviewName = `kubecode-needs-review-${stamp}`
      const reviewPath = `/tmp/${reviewName}`
      const reviewProject = await request.post(`${api}/projects`, { data: { kind: 'create', path: reviewPath } })
      expect(reviewProject.ok(), await reviewProject.text()).toBe(true)
      const reviewId = (await reviewProject.json() as { id: string }).id
      registered.push(reviewId)
      const seed = await seedTaskInReview(request, { api, projectId: reviewId, projectPath: reviewPath, laterMessages: 0 })

      const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: `/tmp/kubecode-needs-you-${stamp}` } })
      expect(created.ok(), await created.text()).toBe(true)
      const projectId = (await created.json() as { id: string }).id
      registered.push(projectId)
      await expect.poll(async () => (await roster(request, api, projectId)).members.some((member) => member.role === 'general')).toBe(true)
      const added = await request.post(`${api}/projects/${projectId}/members`, {
        data: { name: 'Analyst', template: 'analysis', client_request_id: `analyst-${stamp}` },
      })
      expect(added.ok(), await added.text()).toBe(true)
      const analyst = (await roster(request, api, projectId)).members.find((member) => member.handle === 'analyst')!

      await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
      await nothingWaits(page)

      // 1. A member asks permission: one count, one bell entry, one prompt above the composer.
      await send(page, '@analyst [smoke:permission] run the tests')
      await waitForPrompt(analyst.public_conversation_id!, (text) => text.includes('[smoke:permission]'))
      await expect(strip(page)).toContainText('Analyst is waiting for your permission', { timeout: 30_000 })
      await expect(needsYouPlace(page).locator('.kubecode-research-badge')).toHaveText('1')
      // The bell has this Workspace's request and the other Workspace's review.
      const bell = page.getByRole('button', { name: 'Needs you: 2' })
      await expect(bell).toBeVisible()
      await bell.click()
      await expect(page.getByRole('menuitem', { name: /Analyst wants to use Run pytest -q/ })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: `${reviewName}: 1` })).toBeVisible()
      await page.keyboard.press('Escape')

      // 2. Sending stays possible while the member waits, and says only what the server proved.
      await send(page, 'Meanwhile, keep notes on the sweep.')
      await expect(row(page, 'Meanwhile, keep notes on the sweep.')).toContainText(/Delivered to /, { timeout: 30_000 })
      await expect(row(page, '@analyst [smoke:permission] run the tests')).not.toContainText('Delivered to')

      // 3. Needs you lists it once; the row opens the prompt where it is answered,
      // focused; answering clears every surface.
      await openNeedsYou(page)
      const asked = decisions(page).getByRole('button', { name: /Analyst wants to use Run pytest -q/ })
      await expect(asked).toBeVisible({ timeout: 30_000 })
      await expect(decisions(page).getByRole('button')).toHaveCount(1)
      await expect(asked).toContainText('Permission')
      await asked.click()
      await expect.poll(() => page.url()).toMatch(/\/general$/)
      const prompt = page.getByTestId('permission-queue-card')
      await expect(prompt).toBeFocused()
      await expect(prompt).toContainText('Analyst asks permission')
      await prompt.getByRole('button', { name: 'Allow', exact: true }).click()
      await nothingWaits(page)
      await expect(prompt).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Needs you: 1' })).toBeVisible()

      // 4. One Stop per reply, in the strip, never a second beside Send; stopping it ends its request too.
      await send(page, '@analyst [smoke:permission] once more')
      await expect(needsYouPlace(page).locator('.kubecode-research-badge')).toHaveText('1', { timeout: 30_000 })
      const stop = strip(page).getByRole('button', { name: "Stop Analyst's reply" })
      await expect(stop).toBeVisible()
      await expect(page.getByRole('button', { name: /^Stop / })).toHaveCount(1)
      await stop.click()
      await nothingWaits(page)
      await expect(strip(page).getByRole('status')).toHaveText("Stopped Analyst's turn", { timeout: 20_000 })
      await expect(page.getByRole('button', { name: "Stop Analyst's reply" })).toHaveCount(0)

      // 5. The server saves a send but its answer is lost: the send stays as its own
      // row, the composer is free, and Send again replays the same message, never a second one.
      let loseOnce = true
      await page.route('**/channels/*/messages', async (route) => {
        if (route.request().method() === 'POST' && loseOnce) {
          loseOnce = false
          await route.fetch()
          await route.abort()
        } else {
          await route.continue()
        }
      })
      await composer(page).fill('Saved, though its answer was lost.')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const unsent = page.getByRole('list', { name: 'Unsent messages' })
      await expect(unsent.getByRole('alert')).toContainText('Not sent:')
      await expect(composer(page)).toHaveValue('')
      await composer(page).fill('Typed while it was unsent')
      await unsent.getByRole('button', { name: 'Send again' }).click()
      await expect(unsent).toHaveCount(0)
      await expect(log(page).getByText('Saved, though its answer was lost.', { exact: true })).toHaveCount(1)
      await page.reload()
      await expect(log(page).getByText('Saved, though its answer was lost.', { exact: true })).toHaveCount(1)
      await page.unroute('**/channels/*/messages')

      // 6. A review is one row, though its Task is in Review too; it opens the review, focused, and leaves once decided.
      await page.goto(`${workspaceUrl}/#/p/${reviewId}/needs-you`)
      await expect(needsYouView(page).getByRole('heading', { name: 'Needs you', level: 2 })).toBeVisible()
      const review = decisions(page).getByRole('button', { name: new RegExp(`Review the results of ${seed.taskTitle}`) })
      await expect(review).toBeVisible({ timeout: 30_000 })
      await expect(decisions(page).getByRole('button')).toHaveCount(1)
      await review.click()
      await expect.poll(() => page.url()).toContain(`/board?task=${seed.taskId}`)
      const task = inspector(page, 'Task details')
      const region = task.getByRole('region', { name: 'Results for your review' })
      await expect(region).toBeFocused()
      await region.getByRole('textbox', { name: 'Feedback for the team' }).fill('Please rerun with three seeds.')
      await region.getByRole('button', { name: 'Send back' }).click()
      await nothingWaits(page)
      await expect(page.getByRole('button', { name: /^Needs you: / })).toHaveCount(0)
      await page.reload()
      await nothingWaits(page)
      await openNeedsYou(page)
      await expect(needsYouView(page).getByText('Nothing is waiting for you.')).toBeVisible()
    } finally {
      for (const id of registered) await request.delete(`${api}/projects/${id}`)
    }
  })
})

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('@smoke the bell opens a member\'s prompt focused with the navigation sheet closed, and two prompts never push the composer off screen', async ({ page, request }) => {
    test.setTimeout(240_000)
    const { api, workspaceUrl } = urls()
    const stamp = Date.now()
    const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: `/tmp/kubecode-needs-you-phone-${stamp}` } })
    expect(created.ok(), await created.text()).toBe(true)
    const projectId = (await created.json() as { id: string }).id
    try {
      await expect.poll(async () => (await roster(request, api, projectId)).members.some((member) => member.role === 'general')).toBe(true)
      for (const [name, template] of [['Analyst', 'analysis'], ['Writer', 'writing']]) {
        const added = await request.post(`${api}/projects/${projectId}/members`, {
          data: { name, template, client_request_id: `${template}-${stamp}` },
        })
        expect(added.ok(), await added.text()).toBe(true)
      }
      const members = (await roster(request, api, projectId)).members
      const analyst = members.find((member) => member.handle === 'analyst')!
      const writer = members.find((member) => member.handle === 'writer')!

      await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
      await closeNavigationSheet(page)

      // Two members ask permission at once: two prompts above the composer.
      await send(page, '@analyst @writer [smoke:permission] run the checks')
      await waitForPrompt(analyst.public_conversation_id!, (text) => text.includes('[smoke:permission]'))
      await waitForPrompt(writer.public_conversation_id!, (text) => text.includes('[smoke:permission]'))
      await expect(strip(page).getByTestId('permission-queue-card')).toHaveCount(2, { timeout: 30_000 })

      // The bell opens the Analyst's prompt, focused, and the navigation sheet stays closed.
      await page.getByRole('button', { name: 'Needs you: 2' }).click()
      await page.getByRole('menuitem', { name: /Analyst wants to use Run pytest -q/ }).click()
      const prompt = page.getByRole('group', { name: /^Analyst asks permission/ })
      await expect(prompt).toBeFocused()
      await expect(page.getByRole('button', { name: 'Toggle navigation' })).toHaveAttribute('aria-pressed', 'false')

      // Both turns fold into one count that opens their list, each with its Stop; the
      // prompts stay in view, capped; the composer is still on screen and usable.
      const running = strip(page).getByRole('button', { name: '2 running' })
      await expect(running).toBeVisible()
      await running.click()
      const list = page.getByRole('dialog', { name: 'Working now' })
      await expect(list.getByRole('button', { name: /^Stop .*'s reply$/ })).toHaveCount(2)
      await page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
      const stripBox = await strip(page).boundingBox()
      expect(stripBox!.height).toBeLessThanOrEqual(844 * 0.6)
      await expect(composer(page)).toBeInViewport()
      await composer(page).fill('Still reachable with two prompts open.')
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()

      // Answering both ends both turns.
      await prompt.getByRole('button', { name: 'Allow', exact: true }).click()
      await page.getByRole('group', { name: /^Writer asks permission/ }).getByRole('button', { name: 'Allow', exact: true }).click()
      await expect(strip(page).getByTestId('permission-queue-card')).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await request.delete(`${api}/projects/${projectId}`)
    }
  })
})
