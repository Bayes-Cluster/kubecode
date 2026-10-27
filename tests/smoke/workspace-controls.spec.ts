import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

/**
 * The shared Workspace controls in every state (ADR 0227), on the control
 * matrix page: both themes, accessible names, visible keyboard focus, phone
 * touch targets, and long translations that wrap instead of overflowing.
 */
const CONTROLS = [
  '[data-size^="icon-"]:not(:disabled)',
  '[data-testid="matrix-send"]',
  '[data-testid="matrix-stop"]',
  '[data-testid="matrix-pause"]',
  '[data-size="wrap"]:not(:disabled)',
  '[data-reference-chip-action="open"]:is(button)',
  '[data-reference-chip-action="remove"]',
  'button[data-size="inline"]',
  // The agent-ui layer's own controls (ADR 0257): same gallery, their own
  // Clean outline in the focus token instead of the official box-shadow ring.
  '.agx-copy',
  '.agx-segc__opt:not(:disabled)',
  '.agx-src__chip',
  '.agx-src__open',
  '.agx-src__close',
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

/** Long labels wrap: nothing in the narrow samples is wider than its box, clipped or not.
 *  A scroll container clips on purpose — its content stays reachable by scrolling — so its
 *  subtree is exempt (the agent-ui source cards, ADR 0257). */
async function overflowing(page: Page): Promise<string[]> {
  return page.locator('.kubecode-control-matrix-narrow *, .kubecode-control-matrix-tight *').evaluateAll((elements) => elements
    // Text kept only for assistive technology is clipped on purpose.
    .filter((element) => !(element instanceof SVGElement) && !element.classList.contains('sr-only'))
    .filter((element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return false
      }
      return true
    })
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
      // An agent-ui control draws the Clean outline (ADR 0257 §4) in the same focus token.
      const agentUi = element.closest('[class*="agx-"]') !== null
      const outlineRing = style.outlineStyle === 'solid' && Number.parseFloat(style.outlineWidth) >= 2
      return {
        focused: document.activeElement === element,
        ring: agentUi ? outlineRing : rings.some((ring) => style.boxShadow.includes(ring)),
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
    // The touch minimum belongs to the roomy sizes (ADR 0256 §2): xs, icon-xs (dense rows, message actions)
    // and the inline name link keep their own height.
    const targets = CONTROLS.replaceAll(':not(:disabled)', '')
      .replace(', button[data-size="inline"]', '')
      .replace('[data-size^="icon-"]', '[data-size="icon"], [data-size="icon-sm"], [data-size="icon-lg"]')
    const small = await page.locator(targets).evaluateAll((elements) => elements
      .map((element) => ({ box: element.getBoundingClientRect(), name: element.getAttribute('aria-label') ?? element.textContent }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .filter(({ box }) => !(box.width === 0 && box.height === 0))
      .map(({ box, name }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`))
    expect(small).toEqual([])
    // On touch, a stop says in text what it stops.
    await expect(page.getByTestId('matrix-stop-text')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await overflowing(page)).toEqual([])
    expect(await unnamedControls(page)).toEqual([])
  })
})
