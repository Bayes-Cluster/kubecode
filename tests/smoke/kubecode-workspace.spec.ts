import { expect, test } from '@playwright/test'

test('@smoke project, editor, terminal, and project removal', async ({ page }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  await page.goto(workspaceUrl)

  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible()
  const projectName = `kubecode-playwright-${Date.now()}`
  const projectPath = `/tmp/${projectName}`
  await page.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('textbox', { name: 'Full path on this server' }).fill(projectPath)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('button', { name: projectName })).toBeVisible()

  await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('data-state', 'active')
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('textbox', { name: 'Relative path' }).fill('main.py')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('treeitem', { name: 'main.py' }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()

  await page.getByRole('button', { name: 'Toggle terminal' }).click()
  await expect(page.locator('.kubecode-terminal-toolbar')).toHaveText('')
  await expect(page.locator('.xterm')).toBeVisible()

  await page.getByRole('button', { name: 'Split terminal right' }).click()
  await expect(page.locator('.kubecode-terminal-leaf')).toHaveCount(2)
  await expect(page.getByRole('tree', { name: 'Terminal' }).getByRole('treeitem')).toHaveCount(2)
  await expect(page.locator('.kubecode-terminal-toolbar')).toHaveText('')

  const terminalNavigator = page.getByRole('tree', { name: 'Terminal' })
  const navigatorToggle = page.getByRole('button', { name: 'Collapse' })
  await navigatorToggle.click()
  await expect(terminalNavigator).toHaveAttribute('data-narrow', 'true')
  await navigatorToggle.click()

  const firstPane = page.locator('.kubecode-terminal-split-child').first()
  const handle = page.locator('.kubecode-terminal-split > .cursor-col-resize').first()
  const box = await handle.boundingBox()
  if (!box) throw new Error('terminal split handle is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + box.height / 2)
  await page.mouse.up()
  await expect(firstPane).not.toHaveAttribute('style', /50%/)

  await page.locator('.xterm-helper-textarea').last().focus()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.locator('.kubecode-terminal-leaf')).toHaveCount(1)

  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.locator('.kubecode-terminal-pane')).toHaveAttribute('data-open', 'false')

  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('button', { name: projectName })).toHaveCount(0)
})
