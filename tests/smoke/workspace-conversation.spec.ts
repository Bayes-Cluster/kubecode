import { expect, test, type Page } from '@playwright/test'

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
}

/**
 * The shared Workspace conversation against the real Runtime under a non-root
 * base path: discuss in the default channel, keep the discussion across a
 * reload, move one topic into a Thread, and link that Thread to a research
 * question without losing a message. Saving a message never starts an Agent.
 */
test('@smoke workspace conversation keeps a discussion, threads it, and links it to a question', async ({ page }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const projectName = `kubecode-conversation-${Date.now()}`
  const projectPath = `/tmp/${projectName}`

  await page.goto(workspaceUrl)
  await page.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
  await page.getByRole('option', { name: `Create ${projectPath}` }).click()
  await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible()

  // Start from the channel: no question exists yet.
  await page.locator('.kubecode-channel-nav').getByRole('button', { name: 'General' }).click()
  await expect(page.getByText('No messages yet. Start the discussion.')).toBeVisible()
  await page.getByLabel('Message the Workspace').fill('Should we prune the attention heads?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Should we prune the attention heads?')).toBeVisible()
  await page.getByLabel('Message the Workspace').fill('Or quantize first?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Or quantize first?')).toBeVisible()

  // The discussion survives a reload.
  await page.reload()
  await page.locator('.kubecode-channel-nav').getByRole('button', { name: 'General' }).click()
  await expect(page.getByText('Should we prune the attention heads?')).toBeVisible()
  await expect(page.getByText('Or quantize first?')).toBeVisible()

  // One topic becomes a Thread.
  await page.getByTestId('message-1').getByRole('button', { name: 'Reply in thread' }).click()
  const thread = page.getByRole('complementary', { name: 'Thread' })
  await thread.getByLabel('Reply in this thread').fill('Start with magnitude pruning')
  await thread.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(thread.getByText('Start with magnitude pruning')).toBeVisible()
  await expect(page.getByRole('log', { name: 'Messages' }).getByText('Start with magnitude pruning')).toHaveCount(0)

  // A question is created later, and the Thread is linked to it.
  await page.getByRole('button', { name: 'New research question' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title', { exact: true }).fill('Pruning heads')
  await dialog.getByLabel('Question', { exact: true }).fill('Does pruning heads keep accuracy?')
  await dialog.getByRole('button', { name: 'Create question' }).click()
  await expect(page.getByRole('heading', { name: 'Pruning heads' })).toBeVisible()
  await page.locator('.kubecode-channel-nav').getByRole('button', { name: /Should we prune/ }).click()
  const reopened = page.getByRole('complementary', { name: 'Thread' })
  await reopened.getByLabel('Research question').selectOption({ label: 'Pruning heads' })
  await reopened.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(reopened.getByText('Linked to Pruning heads').first()).toBeVisible()
  // Both original messages and the reply are still there.
  await expect(reopened.getByText('Should we prune the attention heads?').first()).toBeVisible()
  await expect(reopened.getByText('Start with magnitude pruning')).toBeVisible()
  await expectContained(page)

  // Narrow screens stack the Thread under the channel and stay contained.
  await page.setViewportSize({ width: 390, height: 800 })
  await expectContained(page)
})
