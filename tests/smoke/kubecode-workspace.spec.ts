import { expect, test } from '@playwright/test'

test('@smoke project, editor, and terminal workspace', async ({ page }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  await page.goto(workspaceUrl)

  await expect(page.locator('.kubecode-brand')).toContainText('Kubecode')
  await page.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('playwright-project')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('button', { name: 'playwright-project' })).toBeVisible()

  await page.getByRole('button', { name: 'New file' }).first().click()
  await page.getByRole('textbox', { name: 'Relative path' }).fill('main.py')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'main.py' }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()

  await page.getByRole('button', { name: 'New terminal' }).click()
  await expect(page.getByRole('button', { name: 'Terminal 1' })).toBeVisible()
  await expect(page.locator('.xterm')).toBeVisible()
})
