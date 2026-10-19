import { expect, test, type Page } from '@playwright/test'
import { openGeneral, workspaceNav } from './shell'

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
}

/**
 * The Workspace's one board against the real Runtime under a non-root base
 * path: a Thread's contextual entry opens the board scoped to it, a task added
 * there is the same card everywhere, commands are revision-checked, and
 * canceled work keeps its reason in its own lane.
 */
test('@smoke work board is one board: scoped entry, same card, commands, closed lane', async ({ page }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const projectName = `kubecode-board-${Date.now()}`
  const projectPath = `/tmp/${projectName}`

  await page.goto(workspaceUrl)
  await page.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
  await page.getByRole('option', { name: `Create ${projectPath}` }).click()
  await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible()

  // Start in the conversation and open a Thread.
  await openGeneral(page)
  await page.getByLabel('Message the Workspace').fill('Should we try dropout?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByTestId('message-1').getByRole('button', { name: 'Reply in thread' }).click()
  const thread = page.getByRole('complementary', { name: 'Thread' })
  await thread.getByRole('button', { name: 'View work from this thread' }).click()

  // The board opens scoped to the Thread; a new task is born of it.
  const board = page.getByRole('region', { name: 'Work', exact: true }).last()
  await expect(board.getByText('No work matches these filters.')).toBeVisible()
  await expect(board.getByText('Scoped to one context')).toBeVisible()
  await board.getByRole('button', { name: 'New task' }).click()
  await board.getByLabel('Title', { exact: true }).fill('Try dropout 0.1')
  await board.getByRole('button', { name: 'Create task' }).click()
  const card = page.locator('[data-testid^="work-card-"]').filter({ hasText: 'Try dropout 0.1' })
  await expect(card).toHaveCount(1)
  await expect(page.getByTestId('work-column-ready')).toContainText('Try dropout 0.1')
  const cardId = await card.first().getAttribute('data-testid')

  // Clearing the scope shows the same card, not a copy.
  await board.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.locator('[data-testid^="work-card-"]').filter({ hasText: 'Try dropout 0.1' })).toHaveCount(1)
  expect(await page.locator('[data-testid^="work-card-"]').first().getAttribute('data-testid')).toBe(cardId)

  // Commands: pause and resume are conditions, not stages.
  await page.getByTestId(cardId!).click()
  const inspector = page.getByRole('complementary', { name: 'Work details' })
  await inspector.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(inspector.getByRole('button', { name: 'Resume' })).toBeVisible()
  await expect(page.getByTestId('work-column-ready')).toContainText('Paused')
  await inspector.getByRole('button', { name: 'Resume' }).click()
  await expect(inspector.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()

  // Nothing is assigned and no round is approved, so no attempt can be started from here.
  await expect(inspector.getByRole('button', { name: 'Start attempt' })).toHaveCount(0)
  // Cancel keeps the card with its reason in the closed lane.
  await inspector.getByRole('button', { name: 'Cancel work…' }).click()
  await inspector.getByRole('textbox', { name: 'Reason' }).fill('Not needed after all')
  await inspector.getByRole('button', { name: 'Canceled', exact: true }).click()
  await expect(page.getByTestId('work-column-ready')).not.toContainText('Try dropout 0.1')
  await page.getByLabel('Show closed work').check()
  const lane = page.getByTestId('work-closed-lane')
  await expect(lane).toContainText('Try dropout 0.1')
  await expect(lane).toContainText('Canceled')

  // Reload keeps it all; narrow screens stay contained.
  await page.reload()
  // Other specs leave Projects behind; choose ours explicitly after the reload.
  await page.getByRole('button', { name: projectName, exact: true }).click()
  await workspaceNav(page).getByRole('button', { name: /^Kanban/ }).click()
  await page.getByLabel('Show closed work').check()
  await expect(page.getByTestId('work-closed-lane')).toContainText('Try dropout 0.1')
  await page.setViewportSize({ width: 390, height: 800 })
  await expectContained(page)
})
