import { expect, test } from '@playwright/test'

test('@smoke project, editor, and terminal workspace', async ({ page }) => {
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

  await page.getByRole('tab', { name: 'Files' }).click()
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('textbox', { name: 'Relative path' }).fill('main.py')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'main.py' }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()

  await page.getByRole('button', { name: 'Toggle terminal' }).click()
  await expect(page.getByRole('tab', { name: 'Terminal 1' })).toBeVisible()
  await expect(page.locator('.xterm')).toBeVisible()

  const agents = await page.evaluate(async () => {
    const response = await fetch('./api/v1/agents')
    return await response.json() as Array<{ available: boolean; id: string }>
  })
  const agentNames = {
    claude_code: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
  } as const

  await page.getByRole('button', { name: 'New session' }).click()
  const agentSelector = page.getByRole('combobox', { name: 'Agent' })
  await expect(agentSelector.locator('img')).toHaveCount(1)
  await agentSelector.click()
  for (const agent of agents) {
    const option = page.getByRole('option', {
      name: agentNames[agent.id as keyof typeof agentNames],
    })
    if (agent.available) await expect(option).not.toHaveAttribute('data-disabled')
    else await expect(option).toHaveAttribute('data-disabled')
  }
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Terminal profiles' }).click()
  for (const agent of agents) {
    const item = page.getByRole('menuitem', {
      name: agentNames[agent.id as keyof typeof agentNames],
    })
    if (agent.available) await expect(item).not.toHaveAttribute('data-disabled')
    else await expect(item).toHaveAttribute('data-disabled')
  }
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Split terminal right' }).click()
  await expect(page.locator('.kubecode-terminal-leaf')).toHaveCount(2)
  const firstPane = page.locator('.kubecode-terminal-split-child').first()
  await expect(firstPane).toHaveAttribute('style', /50%/)
  const handle = page.locator('.kubecode-terminal-split > .cursor-col-resize').first()
  const box = await handle.boundingBox()
  if (!box) throw new Error('terminal split handle is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + box.height / 2)
  await page.mouse.up()
  await expect(firstPane).not.toHaveAttribute('style', /50%/)
})
