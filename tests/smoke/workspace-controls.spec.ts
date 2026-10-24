import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

/**
 * The shared Workspace controls in every state (ADR 0227), on the control
 * matrix page: both themes, accessible names, visible keyboard focus, phone
 * touch targets, and long translations that wrap instead of overflowing.
 */
const CONTROLS = [
  '.kubecode-icon-button:not(:disabled)',
  '.kubecode-send-button:not(:disabled)',
  '.kubecode-stop-button',
  '.kubecode-pause-button',
  '[data-size="wrap"]:not(:disabled)',
  '[data-reference-chip-action="open"]:is(button)',
  '[data-reference-chip-action="remove"]',
  'button.kubecode-member-identity-name',
].join(', ')

function catalog(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(join(process.cwd(), 'src/lib/locales', `${locale}.json`), 'utf8')) as Record<string, string>
}

function matrixUrl(query: string): string {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const base = requested.pathname === '/' ? `${requested.origin}/user/local/kubecode` : requested.href.replace(/\/$/, '')
  return `${base}/#/controls${query}`
}

async function open(page: Page, query: string, locale = 'en') {
  await page.goto(matrixUrl(query))
  await expect(page.getByTestId('control-matrix')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: catalog(locale)['kubecode.matrix.title'] })).toBeVisible()
}

async function unnamedControls(page: Page): Promise<string[]> {
  return page.locator('button, [role="button"], textarea, select, input').evaluateAll((elements) => elements
    .filter((element) => {
      const labelled = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby')
      const text = (element.textContent ?? '').trim()
      const id = element.getAttribute('id')
      const label = id ? document.querySelector(`label[for="${id}"]`) : null
      return !labelled && !text && !label
    })
    .map((element) => element.outerHTML.slice(0, 120)))
}

/** Long labels wrap: nothing in the narrow samples is wider than its box, clipped or not. */
async function overflowing(page: Page): Promise<string[]> {
  return page.locator('.kubecode-control-matrix-narrow *, .kubecode-control-matrix-tight *').evaluateAll((elements) => elements
    // Text kept only for assistive technology is clipped on purpose.
    .filter((element) => !(element instanceof SVGElement) && !element.classList.contains('sr-only'))
    .filter((element) => element.scrollWidth > element.clientWidth + 1)
    .map((element) => element.outerHTML.slice(0, 120)))
}

/** A decision whose words do not fit wraps onto more lines instead of being cut. */
async function wrapsDecision(page: Page): Promise<boolean> {
  return page.getByTestId('decision-wrap-sample').locator('[data-size="wrap"]').evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20
    return element.getBoundingClientRect().height > lineHeight * 1.8
  })
}

/** Every shared control, focused by keyboard, shows the official focus ring in the ring token (ADR 0247). */
async function controlsWithoutFocusRing(page: Page): Promise<string[]> {
  await page.keyboard.press('Tab')
  const count = await page.locator(CONTROLS).count()
  expect(count).toBeGreaterThan(40)
  const missing: string[] = []
  for (let index = 0; index < count; index += 1) {
    const control = page.locator(CONTROLS).nth(index)
    await control.focus()
    const result = await control.evaluate(async (element) => {
      // Buttons transition their shadow; read it once the transition settles.
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
      // The official Button draws `ring-ring/50`, and a destructive one its own
      // `ring-destructive/20` (`/40` in dark): read each through a probe.
      const rings = [
        'color-mix(in oklab, var(--ring) 50%, transparent)',
        'color-mix(in oklab, var(--destructive) 20%, transparent)',
        'color-mix(in oklab, var(--destructive) 40%, transparent)',
      ].map((color) => {
        const probe = document.createElement('span')
        probe.style.color = color
        element.parentElement?.appendChild(probe)
        const value = getComputedStyle(probe).color
        probe.remove()
        return value
      })
      // An official Attachment draws its ring around the whole chip, not on its covering trigger.
      const ringed = element.matches('[data-slot="attachment-trigger"]') ? element.closest('[data-slot="attachment"]') ?? element : element
      const style = getComputedStyle(ringed)
      return {
        focused: document.activeElement === element,
        ring: rings.some((ring) => style.boxShadow.includes(ring)),
        name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.className,
      }
    })
    if (!result.focused || !result.ring) missing.push(result.name)
  }
  return missing
}

for (const theme of ['light', 'dark'] as const) {
  test(`@smoke the Workspace controls are named, focusable, and fit in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await open(page, `?theme=${theme}`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    expect(await unnamedControls(page)).toEqual([])
    expect(await overflowing(page)).toEqual([])
    expect(await wrapsDecision(page)).toBe(true)
    expect(await controlsWithoutFocusRing(page)).toEqual([])
  })
}

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('@smoke the Workspace controls have touch-sized targets and no sideways scroll, in German', async ({ page }) => {
    await open(page, '?theme=light&lang=de-DE', 'de-DE')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true)
    // A member's name is inline text that opens the profile; inline targets are exempt from the size rule.
    const targets = CONTROLS.replaceAll(':not(:disabled)', '').replace(', button.kubecode-member-identity-name', '')
    const small = await page.locator(targets).evaluateAll((elements) => elements
      .map((element) => ({ box: element.getBoundingClientRect(), name: element.getAttribute('aria-label') ?? element.textContent }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .filter(({ box }) => !(box.width === 0 && box.height === 0))
      .map(({ box, name }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`))
    expect(small).toEqual([])
    // On touch, a stop says in text what it stops.
    await expect(page.locator('.kubecode-stop-button-text').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await overflowing(page)).toEqual([])
    expect(await unnamedControls(page)).toEqual([])
  })
})
