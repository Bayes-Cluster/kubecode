import { expect, test } from '@playwright/test'

test('@smoke project, first Agent Session, editor, terminal, and project removal', async ({ page }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  await page.goto(workspaceUrl)

  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible()
  const projectName = `kubecode-playwright-${Date.now()}`
  const projectPath = `/tmp/${projectName}`
  await page.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
  await page.getByRole('option', { name: `Create ${projectPath}` }).click()
  await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Start an agent session' }).click()
  await page.getByRole('combobox', { name: 'Agent' }).click()
  await page.getByRole('option', { name: 'OpenCode' }).click()
  await page.getByRole('textbox', { name: 'Session title' }).fill('Smoke session')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('Smoke session', { exact: true }).first()).toBeVisible()
  await page.setViewportSize({ width: 680, height: 720 })
  const composer = page.getByTestId('agent-composer-surface')
  const addContext = page.getByRole('button', { name: 'Add context' })
  const agentControl = page.getByRole('button', { name: 'Agent settings' })
  await expect(addContext).toBeVisible()
  await expect(agentControl).toBeVisible()
  await expect(agentControl).toContainText('Build')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  const [composerBox, addBox, controlBox] = await Promise.all([
    composer.boundingBox(),
    addContext.boundingBox(),
    agentControl.boundingBox(),
  ])
  if (!composerBox || !addBox || !controlBox) throw new Error('Composer controls are not visible')
  expect(addBox.x).toBeGreaterThanOrEqual(composerBox.x)
  expect(addBox.x + addBox.width).toBeLessThanOrEqual(controlBox.x)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.locator('[contenteditable="true"]').fill('Confirm readiness')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Smoke Agent is ready', { exact: true })).toBeVisible()

  await expect(page.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('data-state', 'active')
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('combobox', { name: 'Relative path' }).fill('main.py')
  await page.getByRole('option', { name: 'Create main.py' }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()
  const editorContent = page.locator('.cm-content')
  const editorScroller = page.locator('.cm-scroller')
  const longDocument = Array.from({ length: 120 }, (_, index) => `print(${index})`).join('\n')
  await editorContent.fill(longDocument)
  await editorContent.press('Control+End')
  await editorScroller.evaluate((element) => { element.scrollTop = element.scrollHeight })
  expect(await editorScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.type('\n# cursor-stays-put')
  await expect(editorContent).toContainText('# cursor-stays-put')
  expect(await editorScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Toggle terminal' }).click()
  await expect(page.locator('.kubecode-terminal-toolbar')).toHaveText('')
  await expect(page.locator('.xterm')).toBeVisible()

  await page.getByRole('button', { name: 'Split terminal right' }).click()
  await expect(page.locator('.kubecode-terminal-leaf')).toHaveCount(2)
  await expect(page.getByRole('tree', { name: 'Terminal' }).getByRole('treeitem')).toHaveCount(2)
  await expect(page.locator('.kubecode-terminal-toolbar')).toHaveText('')

  const terminalNavigator = page.getByRole('tree', { name: 'Terminal' })
  const navigatorToggle = page.getByRole('button', { name: 'Collapse', exact: true })
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

  await page.getByRole('button', { name: `Actions for project ${projectName}` }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('button', { name: projectName, exact: true })).toHaveCount(0)
})
