import { expect, test, type Page } from '@playwright/test'

/**
 * The Workspace prototypes on fixture data (ADR 0233): every screen in both
 * themes, on a desktop and a 390-pixel phone — named controls, no sideways
 * scrolling, visible keyboard focus, and a marked fixture notice.
 */
const SCREENS = [
  { screen: 'general', heading: 'General', inspector: 'Materials' },
  { screen: 'agents', heading: 'General', inspector: 'Work in progress' },
  { screen: 'review', heading: 'RQ-2: Does sparse attention keep recall beyond 64k tokens?', inspector: 'Evidence' },
] as const

function prototypesUrl(query: string): string {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const base = requested.pathname === '/' ? `${requested.origin}/user/local/kubecode` : requested.href.replace(/\/$/, '')
  return `${base}/#/prototypes${query}`
}

async function unnamedControls(page: Page): Promise<string[]> {
  return page.locator('button, a[href], [role="button"], textarea, input').evaluateAll((elements) => elements
    .filter((element) => {
      const labelled = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby')
      const text = (element.textContent ?? '').trim()
      return !labelled && !text
    })
    .map((element) => element.outerHTML.slice(0, 120)))
}

async function check(page: Page, { heading, inspector, screen }: (typeof SCREENS)[number], theme: 'light' | 'dark') {
  await page.goto(prototypesUrl(`?screen=${screen}&theme=${theme}`))
  // The prototypes are a lazily loaded chunk: under a full parallel run its first
  // load can outlast the default 5 s (#229 acceptance flake).
  await expect(page.getByTestId('workspace-prototypes')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.getByRole('note')).toContainText('Sample data only')
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Workspace places' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: inspector })).toBeAttached()
  expect(await unnamedControls(page)).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  // Keyboard focus lands on a control and is visibly ringed.
  await page.keyboard.press('Tab')
  const ring = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    if (!active || active === document.body) return 'none'
    return getComputedStyle(active).boxShadow
  })
  expect(ring).not.toBe('none')
}

for (const theme of ['light', 'dark'] as const) {
  for (const entry of SCREENS) {
    test(`@smoke the ${entry.screen} prototype is named, focusable, and fits on a desktop in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await check(page, entry, theme)
    })
  }
}

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  for (const theme of ['light', 'dark'] as const) {
    for (const entry of SCREENS) {
      test(`@smoke the ${entry.screen} prototype fits a phone without sideways scrolling in the ${theme} theme`, async ({ page }) => {
        await check(page, entry, theme)
      })
    }
  }

  test('@smoke the Task review returns to where it was opened from', async ({ page }) => {
    await page.goto(prototypesUrl('?screen=agents'))
    await page.getByRole('link', { name: 'Open the Task review' }).click()
    await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Back to Needs you' }).click()
    await expect(page.getByRole('complementary', { name: 'Work in progress' })).toBeVisible()
  })
})
