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

export async function openGeneral(page: Page) {
  await workspaceNav(page).getByRole('button', { name: 'General' }).first().click()
}

/** Retries until the URL names the place, since the address is written after render. */
export async function expectUrl(page: Page, fragment: string) {
  await expect.poll(() => page.url()).toContain(fragment)
}
