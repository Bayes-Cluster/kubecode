import { expect, type Page } from '@playwright/test'

/** The Workspace navigation: General, Kanban, Resources, Members. */
export function workspaceNav(page: Page) {
  return page.getByRole('region', { name: 'Workspace', exact: true })
}

/** Legacy questions and Threads live under History; open it if it is closed. */
export async function openHistory(page: Page) {
  const history = page.locator('.kubecode-history-nav')
  if (!(await history.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await history.locator('summary').click()
  }
  await expect(history).toHaveJSProperty('open', true)
}

/** Execution history (Sessions, Teams, the Session search), opened. */
export async function openExecutionHistory(page: Page) {
  await openHistory(page)
  const history = page.locator('.kubecode-history-nav')
  await expect(history.getByRole('textbox', { name: 'Search Sessions in all Workspaces' })).toBeVisible()
  return history
}

/** The inspector showing `name` (an aside: "Task details", "Evidence details", a member's name). */
export function inspector(page: Page, name: string) {
  return page.getByRole('complementary', { name, exact: true })
}

/** Shows or hides the navigation (an overlay sheet on a phone). */
export async function toggleNavigation(page: Page) {
  await page.getByRole('button', { name: 'Toggle navigation' }).click()
}

/** On a phone the navigation is a sheet over the view: once the layout is narrow, put it away. */
export async function closeNavigationSheet(page: Page) {
  await expect(page.locator('.kubecode-workspace')).toHaveAttribute('data-narrow', 'true')
  const toggle = page.getByRole('button', { name: 'Toggle navigation' })
  if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
}

/** Enters a Workspace from the Workspaces list, at the place it was left in. */
export async function selectWorkspace(page: Page, name: string) {
  await page.getByRole('list', { name: 'Workspaces' }).getByRole('button', { name, exact: true }).click()
}

export async function openGeneral(page: Page) {
  await workspaceNav(page).getByRole('button', { name: 'General' }).first().click()
}

/** Retries until the URL names the place, since the address is written after render. */
export async function expectUrl(page: Page, fragment: string) {
  await expect.poll(() => page.url()).toContain(fragment)
}

/**
 * Wraps the workspace event stream so a test can drop and restore it: the
 * browser keeps an open stream through `setOffline`, so a dropped connection
 * has to be simulated at the stream itself. Call before the first navigation.
 */
export async function installControlledEvents(page: Page) {
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
  })
}

export async function dropEvents(page: Page) {
  await page.evaluate(() => (window as unknown as { __disconnectWorkspaceEvents: () => void }).__disconnectWorkspaceEvents())
}

export async function restoreEvents(page: Page) {
  await page.evaluate(() => (window as unknown as { __reconnectWorkspaceEvents: () => void }).__reconnectWorkspaceEvents())
}
