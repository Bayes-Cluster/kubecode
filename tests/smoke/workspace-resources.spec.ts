import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { closeNavigationSheet, inspector, workspaceNav } from './shell'

/**
 * Finding, previewing, and citing Workspace material against the real Runtime
 * under the base path (#219, ADR 0231): Add context finds a Project file,
 * previews it, attaches the version it showed, and returns to the same draft,
 * Task filter, and caret; the sent message names it with that version and
 * says when it changed; Resources previews beside the list and never leaves;
 * Browse in Resources returns to the draft; the titlebar search names its
 * scope; a direct message is never found; and a phone stays usable.
 */

function urls() {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  return { workspaceUrl, api: `${workspaceUrl}/api/v1` }
}

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
}

type Roster = { members: Array<{ id: string; role: string; handle: string; public_conversation_id: string | null }> }

async function roster(request: APIRequestContext, api: string, projectId: string): Promise<Roster> {
  return (await (await request.get(`${api}/projects/${projectId}/members`)).json()) as Roster
}

const digest = (text: string) => `#${createHash('sha256').update(text).digest('hex').slice(0, 7)}`
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message the Workspace' })
const caretOf = (page: Page) => composer(page).evaluate((box) => (box as HTMLTextAreaElement).selectionStart)

test.describe('on a desktop', () => {
  test.use({ hasTouch: false })

  test('@smoke a file is found, previewed, attached at the version shown, and cited without losing the draft', async ({ page, request }) => {
    test.setTimeout(240_000)
    const { api, workspaceUrl } = urls()
    const stamp = Date.now()
    const projectName = `kubecode-resources-${stamp}`
    const projectPath = `/tmp/${projectName}`
    let projectId: string | undefined
    try {
      const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: projectPath } })
      expect(created.ok(), await created.text()).toBe(true)
      projectId = (await created.json() as { id: string }).id
      await expect.poll(async () => (await roster(request, api, projectId!)).members.filter((member) => member.role === 'general').length).toBe(1)
      const task = await (await request.post(`${api}/projects/${projectId}/research`, {
        data: { title: 'Prune heads', question: 'Does pruning heads keep accuracy?', client_request_id: `task-${stamp}` },
      })).json() as { id: string }
      await mkdir(`${projectPath}/results`, { recursive: true })
      const first = 'model,accuracy\nbaseline,0.92\npruned,0.91\n'
      await writeFile(`${projectPath}/results/summary.csv`, first)

      // 1. General about the Task, a draft with the caret in the middle of it.
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${workspaceUrl}/#/p/${projectId}/general?filter=${task.id}`)
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
      await composer(page).fill('compare with the baseline')
      await composer(page).evaluate((box) => (box as HTMLTextAreaElement).setSelectionRange(8, 8))
      const before = page.url()

      // 2. Add context: the search names its scope, the preview shows the file, and the version shown is attached.
      await page.getByRole('button', { name: 'Add context' }).click()
      await page.getByRole('menuitem', { name: 'Attach from this Workspace…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add context' })
      await expect(dialog.getByRole('note')).toContainText(`in ${projectName}.`)
      await expect(dialog.getByRole('note')).toContainText('Message text and direct messages are never searched.')
      const search = dialog.getByRole('combobox', { name: `Search ${projectName}` })
      await search.fill('summary')
      await expect(dialog.getByRole('option', { name: /results\/summary\.csv/ })).toBeVisible()
      await search.press('ArrowRight')
      await expect(dialog.getByText('pruned,0.91')).toBeVisible()
      const attach = dialog.getByRole('button', { name: 'Attach this version' })
      await expect(attach).toBeEnabled()
      expect(page.url()).toBe(before)
      await attach.click()
      await expect(dialog).toHaveCount(0)

      // Back in the same draft: text, caret, and Task filter unchanged; the chip names the file and its version.
      const chipName = `File results/summary.csv ${digest(first)}`
      await expect(page.locator('[data-composer-about]').getByRole('button', { name: chipName })).toBeVisible()
      await expect(composer(page)).toBeFocused()
      await expect(composer(page)).toHaveValue('compare with the baseline')
      expect(await caretOf(page)).toBe(8)
      expect(page.url()).toContain(`filter=${task.id}`)

      // 3. Sent, the message cites the same name and version, never an id, as a source card.
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const message = page.locator('article[data-message-id]').filter({ hasText: 'compare with the baseline' })
      const card = message.getByRole('button', { name: new RegExp(`File 1 ${chipName.split(' ')[2]} results/summary\\.csv`) })
      await expect(card).toBeVisible()
      await expect(message).not.toContainText(createHash('sha256').update(first).digest('hex').slice(0, 12))

      // The file changes: the card says so, still naming the version cited.
      await writeFile(`${projectPath}/results/summary.csv`, `${first}pruned-more,0.88\n`)
      await expect(message.getByRole('button', { name: new RegExp(`File 1 ${chipName.split(' ')[2]} Changed since cited results/summary\\.csv`) })).toBeVisible({ timeout: 30_000 })
      // Cited materials are the message's Sources (ADR 0236): the collapsed trigger still warns, and the list fits the message.
      await expect(message.getByRole('button', { name: 'Sources (1) · 1 changed or gone' })).toBeVisible()
      const [messageBox, sourcesBox] = await Promise.all([
        message.boundingBox(),
        message.getByRole('list', { name: 'References' }).boundingBox(),
      ])
      expect(sourcesBox!.x + sourcesBox!.width).toBeLessThanOrEqual(messageBox!.x + messageBox!.width + 1)

      // 4. Resources is a library: a row previews beside the list, and the place is kept across a visit elsewhere.
      await workspaceNav(page).getByRole('button', { name: 'Resources' }).click()
      await expect(page.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
      const resources = page.getByRole('region', { name: 'Resources' })
      await expect(resources.getByRole('note')).toContainText('never searched')
      await resources.getByRole('combobox', { name: `Search ${projectName}` }).fill('summary')
      const row = resources.getByRole('option', { name: /results\/summary\.csv/ })
      await row.click()
      const preview = inspector(page, 'Resource details')
      await expect(preview.getByText('pruned-more,0.88')).toBeVisible()
      await expect(row).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
      // A file path never enters the address.
      expect(page.url()).not.toContain('summary')
      await workspaceNav(page).getByRole('button', { name: /^Kanban/ }).click()
      await expect(page.getByRole('heading', { name: 'Kanban', level: 2 })).toBeVisible()
      await workspaceNav(page).getByRole('button', { name: 'Resources' }).click()
      await expect(resources.getByRole('combobox', { name: `Search ${projectName}` })).toHaveValue('summary')

      // 5. Browse in Resources from a draft, preview there, and Add to message returns to that draft.
      await workspaceNav(page).getByRole('button', { name: 'General' }).first().click()
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
      await composer(page).fill('and the plot')
      await page.getByRole('button', { name: 'Add context' }).click()
      await page.getByRole('menuitem', { name: 'Attach from this Workspace…' }).click()
      await page.getByRole('dialog', { name: 'Add context' }).getByRole('button', { name: 'Browse in Resources' }).click()
      await expect(page.getByText('Adding to your message in General.')).toBeVisible()
      await resources.getByRole('option', { name: /results\/summary\.csv/ }).click()
      const add = inspector(page, 'Resource details').getByRole('button', { name: 'Add to message' })
      await expect(add).toBeEnabled()
      await add.click()
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
      expect(page.url()).toContain(`filter=${task.id}`)
      await expect(composer(page)).toBeFocused()
      await expect(composer(page)).toHaveValue('and the plot')
      await expect(page.locator('[data-composer-about]').getByRole('button', { name: /^File results\/summary\.csv #/ })).toBeVisible()

      // 6. The titlebar search names the Workspace and previews over General.
      await page.getByRole('button', { name: `Search ${projectName}` }).click()
      const quick = page.getByRole('combobox', { name: `Search ${projectName}` })
      await quick.fill('prune')
      await expect(page.getByRole('listbox', { name: 'Results' }).getByRole('option', { name: /Prune heads/ })).toBeVisible()
      await quick.press('Enter')
      await expect(inspector(page, 'Task details')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
    } finally {
      if (projectId) await request.delete(`${api}/projects/${projectId}`)
    }
  })

  test('@smoke a direct message is never found, even in execution history', async ({ page, request }) => {
    test.setTimeout(180_000)
    const { api, workspaceUrl } = urls()
    const stamp = Date.now()
    const projectName = `kubecode-resources-private-${stamp}`
    let projectId: string | undefined
    try {
      const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: `/tmp/${projectName}` } })
      expect(created.ok(), await created.text()).toBe(true)
      projectId = (await created.json() as { id: string }).id
      const analyst = await request.post(`${api}/projects/${projectId}/members`, {
        data: { name: 'Analyst', template: 'analysis', client_request_id: `analyst-${stamp}` },
      })
      expect(analyst.ok(), await analyst.text()).toBe(true)
      const member = await analyst.json() as { id: string }
      const opened = await request.post(`${api}/projects/${projectId}/members/${member.id}/dm`)
      expect(opened.ok(), await opened.text()).toBe(true)
      const { dm_conversation_id: dmSession } = await opened.json() as { dm_conversation_id: string | null }
      expect(dmSession).toBeTruthy()
      const word = `zanzibarite${stamp}`
      // The word is the private Session's title, which a Session search does match; only privacy keeps it out.
      const renamed = await request.patch(`${api}/sessions/${dmSession}`, { data: { manual_title: `private ${word}` } })
      expect(renamed.ok(), await renamed.text()).toBe(true)
      expect(JSON.stringify(await renamed.json())).toContain(word)

      await page.goto(`${workspaceUrl}/#/p/${projectId}/resources`)
      const resources = page.getByRole('region', { name: 'Resources' })
      await resources.getByRole('group', { name: 'Search in' }).getByRole('button', { name: /^History/ }).click()
      await expect(resources.getByRole('group', { name: 'Search in' }).getByRole('button', { name: /^History/ })).toHaveAttribute('aria-pressed', 'true')
      await resources.getByRole('combobox', { name: `Search ${projectName}` }).fill(word)
      await expect(resources.getByText(`matches “${word}”.`, { exact: false })).toBeVisible()
      await expect(resources.getByRole('option')).toHaveCount(0)
    } finally {
      if (projectId) await request.delete(`${api}/projects/${projectId}`)
    }
  })
})

test('@smoke on a phone, search opens Resources, a preview is its own screen, and Add context fits', async ({ page, request }) => {
  test.setTimeout(180_000)
  const { api, workspaceUrl } = urls()
  const stamp = Date.now()
  const projectName = `kubecode-resources-phone-${stamp}`
  const projectPath = `/tmp/${projectName}`
  let projectId: string | undefined
  try {
    const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: projectPath } })
    expect(created.ok(), await created.text()).toBe(true)
    projectId = (await created.json() as { id: string }).id
    await expect.poll(async () => (await roster(request, api, projectId!)).members.filter((member) => member.role === 'general').length).toBe(1)
    await mkdir(`${projectPath}/results/very/long/folder/names/that/must/wrap`, { recursive: true })
    await writeFile(`${projectPath}/results/very/long/folder/names/that/must/wrap/summary-of-the-pruning-sweep.csv`, 'a,b\n1,2\n')

    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
    await closeNavigationSheet(page)
    await page.getByRole('button', { name: 'Search this Workspace' }).click()
    await expect(page.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
    const search = page.getByRole('combobox', { name: `Search ${projectName}` })
    await expect(search).toBeFocused()
    await search.fill('pruning sweep')
    const row = page.getByRole('option', { name: /summary-of-the-pruning-sweep\.csv/ })
    await expect(row).toBeVisible()
    await expectContained(page)
    await row.click()
    const preview = inspector(page, 'Resource details')
    await expect(preview.getByText('1,2')).toBeVisible()
    await expectContained(page)
    await preview.getByRole('button', { name: 'Back to Resources' }).click()
    await expect(search).toHaveValue('pruning sweep')
    await expect(row).toBeVisible()

    await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
    await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
    await page.getByRole('button', { name: 'Add context' }).click()
      await page.getByRole('menuitem', { name: 'Attach from this Workspace…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add context' })
    await dialog.getByRole('combobox').fill('pruning sweep')
    await dialog.getByRole('option', { name: /summary-of-the-pruning-sweep\.csv/ }).click()
    const attach = dialog.getByRole('button', { name: 'Attach this version' })
    await expect(attach).toBeEnabled()
    const box = await attach.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    await expect(dialog.getByRole('button', { name: 'Back to results' })).toBeVisible()
    await expectContained(page)
    await attach.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Message the Workspace' }).or(page.getByRole('textbox', { name: 'Message the Workspace' }))).toBeFocused()
  } finally {
    if (projectId) await request.delete(`${api}/projects/${projectId}`)
  }
})
