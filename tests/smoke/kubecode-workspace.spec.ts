import { expect, test } from '@playwright/test'

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __closeWorkspaceEvents?: () => void })
      .__closeWorkspaceEvents?.()
  }).catch(() => undefined)
})

test('@smoke project, reconnect recovery, editor, terminal, and project removal', async ({ page, request }, testInfo) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    class ControlledEventSource extends EventTarget {
      static current: ControlledEventSource | null = null
      onerror: ((event: Event) => void) | null = null
      onopen: ((event: Event) => void) | null = null
      private source: EventSource | null = null
      constructor(private readonly url: string | URL, private readonly init?: EventSourceInit) {
        super()
        ControlledEventSource.current = this
        this.connect()
      }
      private connect() {
        const source = new NativeEventSource(this.url, this.init)
        this.source = source
        source.onopen = (event) => this.onopen?.(event)
        source.onerror = (event) => this.onerror?.(event)
        source.addEventListener('workspace_event', (event) => {
          this.dispatchEvent(new MessageEvent('workspace_event', {
            data: (event as MessageEvent<string>).data,
            lastEventId: (event as MessageEvent<string>).lastEventId,
          }))
        })
      }
      close() {
        this.source?.close()
        this.source = null
      }
      disconnect() {
        this.close()
        this.onerror?.(new Event('error'))
      }
      reconnect() {
        if (!this.source) this.connect()
      }
    }
    window.EventSource = ControlledEventSource as unknown as typeof EventSource
    Object.defineProperty(window, '__disconnectWorkspaceEvents', {
      value: () => ControlledEventSource.current?.disconnect(),
    })
    Object.defineProperty(window, '__reconnectWorkspaceEvents', {
      value: () => ControlledEventSource.current?.reconnect(),
    })
    Object.defineProperty(window, '__closeWorkspaceEvents', {
      value: () => ControlledEventSource.current?.close(),
    })
  })
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
  const projectsResponse = await request.get(`${workspaceUrl}/api/v1/projects`)
  expect(projectsResponse.ok()).toBeTruthy()
  const projects = await projectsResponse.json() as Array<{ id: string; name: string }>
  const projectId = projects.find((project) => project.name === projectName)?.id
  if (!projectId) throw new Error('Created smoke project was not returned by the API')

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
  const connectionBox = await page.getByRole('button', { name: /Runtime connection:/ }).boundingBox()
  if (!connectionBox) throw new Error('Runtime connection control is not visible')
  expect(connectionBox.x + connectionBox.width).toBeLessThanOrEqual(680)
  const narrowDocument = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(narrowDocument.scrollWidth).toBeLessThanOrEqual(narrowDocument.clientWidth)
  await page.screenshot({ path: testInfo.outputPath('runtime-connection-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.locator('[contenteditable="true"]').fill('Confirm readiness')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Smoke Agent is ready', { exact: true })).toBeVisible()
  const projectButton = page.getByRole('button', { name: projectName, exact: true })
  await expect(projectButton).toHaveAttribute('data-session-status', 'running')
  await expect(page.getByRole('button', { name: 'Runtime connection: Live' })).toBeVisible()

  await page.evaluate(() => {
    (window as unknown as { __disconnectWorkspaceEvents: () => void })
      .__disconnectWorkspaceEvents()
  })
  await expect(page.getByRole('button', { name: 'Runtime connection: Reconnecting' })).toBeVisible()
  await expect.poll(async () => {
    const response = await request.get(
      `${workspaceUrl}/api/v1/projects/${encodeURIComponent(projectId)}/runs`,
    )
    expect(response.ok()).toBeTruthy()
    const runs = await response.json() as Array<{ status: string }>
    return runs[0]?.status
  }).toBe('completed')
  await expect(projectButton).toHaveAttribute('data-session-status', 'running')
  await page.evaluate(() => {
    (window as unknown as { __reconnectWorkspaceEvents: () => void })
      .__reconnectWorkspaceEvents()
  })
  await expect(page.getByRole('button', { name: 'Runtime connection: Live' })).toBeVisible()
  await expect(projectButton).not.toHaveAttribute('data-session-status', 'running')
  const connectionTrigger = page.getByRole('button', { name: 'Runtime connection: Live' })
  await connectionTrigger.click()
  await expect(page.getByText('Last successful sync')).toBeVisible()
  await expect(page.getByText('Never')).toHaveCount(0)
  await page.keyboard.press('Escape')

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

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Agents' }).click()
  const runtimePanel = page.getByTestId('runtime-status-panel')
  await expect(runtimePanel).toContainText('Active')
  await expect(runtimePanel).toContainText('Idle')
  await expect(runtimePanel).toContainText('Warm limit')
  await runtimePanel.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('runtime-settings-desktop.png') })
  await page.setViewportSize({ width: 680, height: 720 })
  await runtimePanel.scrollIntoViewIfNeeded()
  const [dialogBox, runtimeBox] = await Promise.all([
    page.getByRole('dialog').boundingBox(),
    runtimePanel.boundingBox(),
  ])
  if (!dialogBox || !runtimeBox) throw new Error('Runtime settings layout is not visible')
  const layoutDetails = await page.getByRole('dialog').evaluate((element) => {
    const style = getComputedStyle(element)
    return { grid: style.gridTemplateColumns, maxWidth: style.maxWidth, viewport: innerWidth, width: style.width }
  })
  expect(dialogBox.x, JSON.stringify(layoutDetails)).toBeGreaterThanOrEqual(0)
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(680)
  expect(runtimeBox.x).toBeGreaterThanOrEqual(dialogBox.x)
  expect(runtimeBox.x + runtimeBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width)
  const narrowSettings = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(narrowSettings.scrollWidth).toBeLessThanOrEqual(narrowSettings.clientWidth)
  await page.screenshot({ path: testInfo.outputPath('runtime-settings-narrow.png') })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.getByRole('button', { name: `Actions for project ${projectName}` }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('button', { name: projectName, exact: true })).toHaveCount(0)
})
