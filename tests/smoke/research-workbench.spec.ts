import { mkdir, writeFile } from 'node:fs/promises'

import { expect, test, type Page } from '@playwright/test'
import { openHistory } from './shell'

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => {
    const workspace = document.querySelector('.kubecode-research-workspace')
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      // The research pane scrolls internally, so check it separately.
      paneClientWidth: workspace?.clientWidth ?? 0,
      paneScrollWidth: workspace?.scrollWidth ?? 0,
    }
  })
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
  expect(viewport.paneScrollWidth).toBeLessThanOrEqual(viewport.paneClientWidth + 1)
}

/**
 * One research question followed end to end against the real Runtime under a
 * non-root base path: create and refine the brief, discuss in a linked Session,
 * start a round that records the revision it used, record a finding with file
 * evidence, then see a changed file and a revised brief reported honestly after
 * a reload. Standalone Sessions stay reachable throughout.
 */
test('@smoke research question carries context from discussion through a round to findings', async ({ page, request }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const projectName = `kubecode-research-${Date.now()}`
  const projectPath = `/tmp/${projectName}`
  const title = 'Structured pruning'

  try {
    await page.goto(workspaceUrl)
    await page.getByRole('button', { name: 'Add project' }).click()
    await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
    await page.getByRole('option', { name: `Create ${projectPath}` }).click()
    await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible()
    await mkdir(projectPath, { recursive: true })
    await writeFile(`${projectPath}/results.csv`, 'accuracy\n0.91\n')

    // Create: saving only records the question; nothing runs.
    await openHistory(page)
    await page.getByRole('button', { name: 'New research question' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title', { exact: true }).fill(title)
    await dialog.getByLabel('Question', { exact: true }).fill('Does structured pruning keep accuracy within one point?')
    await dialog.getByRole('button', { name: 'Create question' }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect(page.getByText('Brief revision 1').first()).toBeVisible()

    // Discuss: a note is recorded without starting any work.
    await page.getByRole('tab', { name: 'Discussion' }).click()
    await page.getByLabel('Note or decision').fill('Start with the late layers')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('Start with the late layers')).toBeVisible()

    // A linked discussion Session opens in the ordinary Session view, and the
    // question is one click away.
    await page.getByRole('button', { name: 'Start discussion Session' }).click()
    await expect(page.getByRole('heading', { name: title })).toHaveCount(0)
    await openHistory(page)
    await page.getByLabel('Research', { exact: true }).getByRole('button', { name: title }).click()
    await page.getByRole('tab', { name: 'Discussion' }).click()
    await expect(page.getByRole('button', { name: 'Open Session' })).toBeVisible()

    // Start the next round explicitly; it records the brief revision it used.
    await page.getByRole('tab', { name: 'Work' }).click()
    await expect(page.getByText('Starting a round runs an Agent.')).toBeVisible()
    await page.getByRole('combobox', { name: 'Mode' }).click()
    await page.getByRole('option', { name: 'Solo' }).click()
    await page.getByLabel('Instruction').fill('Compare pruning ratios')
    await page.getByRole('button', { name: 'Start round 1' }).click()
    const round = page.getByRole('listitem').filter({ hasText: 'Round 1' })
    await expect(round).toContainText('used brief revision 1')
    await expect(round).toContainText('Started')

    // Record a finding with file evidence.
    await page.getByRole('tab', { name: 'Findings' }).click()
    await page.getByLabel('What was found').fill('Accuracy held at 0.91')
    await page.getByLabel('Evidence file').fill('results.csv')
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    const finding = page.getByRole('listitem').filter({ hasText: 'Accuracy held at 0.91' })
    await expect(finding).toContainText('Observation')
    await expect(finding).toContainText('results.csv')
    await expect(finding).toContainText('Available')

    // The file changes and the brief is revised; after a reload the record
    // converges and says so instead of pretending nothing moved.
    await writeFile(`${projectPath}/results.csv`, 'accuracy\n0.50\n')
    await page.getByRole('tab', { name: 'Brief' }).click()
    await page.getByRole('button', { name: 'Edit brief' }).click()
    await page.getByLabel('Constraints', { exact: true }).fill('single GPU')
    await page.getByRole('button', { name: 'Save brief' }).click()
    await expect(page.getByText('Brief revision 2').first()).toBeVisible()

    await page.reload()
    await openHistory(page)
    await page.getByLabel('Research', { exact: true }).getByRole('button', { name: title }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect(page.getByText('Brief revision 2').first()).toBeVisible()
    await page.getByRole('tab', { name: 'Findings' }).click()
    const reloaded = page.getByRole('listitem').filter({ hasText: 'Accuracy held at 0.91' })
    await expect(reloaded).toContainText('Changed')
    await expect(reloaded).toContainText('Brief changed since')
    await page.getByRole('tab', { name: 'Work' }).click()
    const reloadedRound = page.getByRole('listitem').filter({ hasText: 'Round 1' })
    await expect(reloadedRound).toContainText('used brief revision 1')
    await expect(reloadedRound).toContainText('Brief changed since')
    await expect(page.getByText('It will use brief revision 2.')).toBeVisible()

    // Mobile width stays usable and contained.
    await page.setViewportSize({ width: 390, height: 844 })
    await expectContained(page)
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
