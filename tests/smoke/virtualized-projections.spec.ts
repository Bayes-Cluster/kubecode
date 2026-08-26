import { expect, test } from '@playwright/test'

const visibleFiles = Array.from({ length: 1_200 }, (_value, index) => ({
  name: `file-${index}.ts`,
  path: `file-${index}.ts`,
  kind: 'file',
}))
const gitFiles = [
  ...Array.from({ length: 210 }, (_value, index) => ({
    path: `conflict-${index}.txt`,
    index_status: 'U',
    worktree_status: 'U',
    conflict: true,
  })),
  ...Array.from({ length: 210 }, (_value, index) => ({
    path: `staged-${index}.txt`,
    index_status: 'M',
    worktree_status: null,
    conflict: false,
  })),
  ...Array.from({ length: 210 }, (_value, index) => ({
    path: `changed-${index}.txt`,
    index_status: null,
    worktree_status: 'M',
    conflict: false,
  })),
]

test('@smoke virtualized projections stay bounded and contained on desktop and mobile', async ({ page, request }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const projectName = `kubecode-virtualized-${Date.now()}`
  const projectPath = `/tmp/${projectName}`

  await page.route('**/api/v1/projects/*/entries*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    const url = new URL(route.request().url())
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(url.searchParams.get('path') ? [] : visibleFiles),
      status: 200,
    })
  })
  await page.route('**/api/v1/projects/*/git/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        branch: 'main',
        files: gitFiles,
        is_repository: true,
        truncated: false,
      }),
      status: 200,
    })
  })

  try {
    await page.goto(workspaceUrl)
    await page.getByRole('button', { name: 'Add project' }).click()
    await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
    await page.getByRole('option', { name: `Create ${projectPath}` }).click()
    const projectButton = page.getByRole('button', { name: projectName, exact: true })
    await expect(projectButton).toBeVisible()
    await projectButton.click()

    const contextToggle = page.getByRole('button', { name: 'Toggle context panel' })
    if (await contextToggle.getAttribute('aria-pressed') !== 'true') {
      await expect(contextToggle).toHaveAttribute('aria-pressed', 'false')
      await contextToggle.click()
    }
    await expect(contextToggle).toHaveAttribute('aria-pressed', 'true')
    const tree = page.getByRole('tree', { name: projectName })
    await expect(tree).toHaveAttribute('data-virtualized', 'true')
    await expect.poll(() => tree.getByRole('treeitem').count()).toBeGreaterThan(0)
    expect(await tree.getByRole('treeitem').count()).toBeLessThan(1_201)

    await tree.focus()
    for (let index = 0; index < 260; index += 1) await page.keyboard.press('ArrowDown')
    await expect(tree).toHaveAttribute('data-active-path', 'file-259.ts')
    await expect(tree.getByRole('treeitem', { name: 'file-259.ts' })).toBeFocused()
    await expect(tree.getByRole('treeitem', { name: 'file-259.ts' })).toHaveAttribute('aria-selected', 'true')

    for (const group of ['conflict', 'staged', 'worktree']) {
      const section = page.locator(`[data-group="${group}"]`)
      await expect(section).toHaveAttribute('data-virtualized', 'true')
      const list = page.getByTestId(`git-change-virtual-list-${group}`)
      await expect.poll(() => list.locator('.kubecode-git-row').count()).toBeGreaterThan(0)
      expect(await list.locator('.kubecode-git-row').count()).toBeLessThan(210)
    }

    const assertContained = async () => {
      const viewport = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }))
      expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
      const context = await page.getByTestId('context-workbench').boundingBox()
      if (!context) throw new Error('Context workbench is not visible')
      expect(context.x).toBeGreaterThanOrEqual(0)
      expect(context.x + context.width).toBeLessThanOrEqual(viewport.clientWidth)

      const row = page.locator('[data-group="worktree"] .kubecode-git-row').first()
      const rowBox = await row.boundingBox()
      if (!rowBox) throw new Error('A mounted Git row is not visible')
      const buttons = row.locator('button')
      let previousRight = rowBox.x
      for (let index = 0; index < await buttons.count(); index += 1) {
        const button = await buttons.nth(index).boundingBox()
        if (!button) throw new Error('A mounted Git control is not visible')
        expect(button.x).toBeGreaterThanOrEqual(previousRight - 1)
        expect(button.x + button.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
        previousRight = button.x + button.width
      }
    }

    await assertContained()
    await page.setViewportSize({ width: 390, height: 844 })
    // Wait for the narrow layout to settle before touching the toggle: the
    // matchMedia flip lands asynchronously, and the navigator-precedence
    // effect closes the context panel one commit later. Reading aria-pressed
    // before that settle races the click against the forced close.
    await expect(page.locator('.kubecode-workspace')).toHaveAttribute('data-narrow', 'true')
    const mobileContextToggle = page.getByRole('button', { name: 'Toggle context panel' })
    // Both overlays were open on desktop, so narrow entry settles the panel closed.
    await expect(mobileContextToggle).toHaveAttribute('aria-pressed', 'false')
    await mobileContextToggle.click()
    await expect(mobileContextToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('context-workbench')).toBeVisible()
    await assertContained()
  } finally {
    const projects = await request.get(`${workspaceUrl}/api/v1/projects`)
    if (projects.ok()) {
      const registered = await projects.json() as Array<{ id: string; name: string }>
      const project = registered.find((candidate) => candidate.name === projectName)
      if (project) {
        await request.delete(`${workspaceUrl}/api/v1/projects/${encodeURIComponent(project.id)}`)
      }
    }
  }
})
