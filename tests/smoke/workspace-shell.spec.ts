import { expect, test, type Page } from '@playwright/test'

import { expectUrl, openGeneral, workspaceNav } from './shell'

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
}

/**
 * The Workspace shell against the real Runtime under a non-root base path: one
 * navigation (General, Kanban, Resources, Members); a Task opens beside the
 * conversation, from a message and back to it; the place is in the URL hash so
 * a reload, a link, and Back land where the researcher was; Files and Git are
 * tools asked for rather than a permanent column; on a phone the list and its
 * detail are separate screens.
 */
test('@smoke workspace shell moves from General to a Task and back, and keeps its place', async ({ page, request }) => {
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const api = `${workspaceUrl}/api/v1`
  const projectName = `kubecode-shell-${Date.now()}`
  const projectPath = `/tmp/${projectName}`

  await page.goto(workspaceUrl)
  await page.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
  await page.getByRole('option', { name: `Create ${projectPath}` }).click()
  await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible()
  const projects = await (await request.get(`${api}/projects`)).json() as Array<{ id: string; name: string }>
  const project = projects.find((candidate) => candidate.name === projectName)
  if (!project) throw new Error('Project was not registered')

  // A Task (a research question) and a General message about it.
  const question = await (await request.post(`${api}/projects/${project.id}/research`, {
    data: { title: 'Pruning heads', question: 'Does pruning heads keep accuracy?', client_request_id: `q-${Date.now()}` },
  })).json() as { id: string }
  const channels = await (await request.get(`${api}/projects/${project.id}/channels`)).json() as Array<{ id: string }>
  const posted = await request.post(`${api}/projects/${project.id}/channels/${channels[0].id}/messages`, {
    data: {
      body: 'Let us look at pruning heads first.',
      client_message_id: `m-${Date.now()}`,
      references: [{ kind: 'research', id: question.id }],
    },
  })
  expect(posted.ok()).toBe(true)
  const message = await posted.json() as { id: string }
  // Later chatter, so the conversation is longer than the one message.
  for (let index = 0; index < 3; index += 1) {
    await request.post(`${api}/projects/${project.id}/channels/${channels[0].id}/messages`, {
      data: { body: `Later remark ${index}`, client_message_id: `later-${index}-${Date.now()}` },
    })
  }

  await page.reload()
  await page.getByRole('button', { name: projectName, exact: true }).click()
  const nav = workspaceNav(page)
  await expect(nav).toBeVisible()
  // Sessions is a view among others; the pane starts in the Sessions surface.
  await expect(page.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'true')

  // General: the message carries its Task; opening it shows the Task beside the conversation.
  await openGeneral(page)
  await expect(page.getByRole('heading', { name: '# General' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`${workspaceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?#/p/[^/]+/general$`))
  // Files and Git are not a permanent column beside the research views.
  await expect(page.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'false')
  const original = page.locator(`[data-message-id="${message.id}"]`)
  await expect(original).toBeVisible()
  await original.getByRole('button', { name: /Task: Pruning heads/ }).click()
  const detail = page.getByRole('complementary', { name: 'Task details' })
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('heading', { name: 'Pruning heads' })).toBeVisible()
  await expectUrl(page, `/general/m/${message.id}?task=${question.id}`)
  // The conversation stays beside it on a desktop screen.
  await expect(page.getByText('Later remark 2')).toBeVisible()

  // A reload lands on the same Task and message.
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Task details' }).getByRole('heading', { name: 'Pruning heads' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '# General' })).toBeVisible()

  // Closing the Task returns to the message it was opened from.
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('button', { name: 'Close details' }).first().click()
  await expect(page.getByRole('complementary', { name: 'Task details' })).toHaveCount(0)
  await expectUrl(page, `/general/m/${message.id}`)
  await expect(page).not.toHaveURL(/task=/)
  await expect(page.locator(`[data-message-id="${message.id}"]`)).toBeFocused()

  // Files and Git open on request.
  await page.getByRole('button', { name: 'Toggle context panel' }).click()
  await expect(page.getByRole('tab', { name: 'Explorer' })).toBeVisible()
  await page.getByRole('button', { name: 'Toggle context panel' }).click()

  // Resources: the Project's records, previewed read-only.
  await workspaceNav(page).getByRole('button', { name: 'Resources' }).click()
  await expect(page.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
  await expect(page.getByRole('option', { name: /Pruning heads/ })).toBeVisible()
  await expectUrl(page, '/resources')

  // Members: the roster, with the General Agent.
  await workspaceNav(page).getByRole('button', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible()
  await expect(page.getByRole('list').getByText('@general').first()).toBeVisible()

  // Back walks back through the views.
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: '# General' })).toBeVisible()

  // The one board.
  await workspaceNav(page).getByRole('button', { name: /^Kanban/ }).click()
  await expect(page.getByRole('region', { name: 'Kanban', exact: true })).toBeVisible()
  await expectUrl(page, '/board')

  // On a phone, the conversation and the Task are separate screens.
  await page.setViewportSize({ width: 390, height: 800 })
  // The navigation is an overlay on a phone; dismiss it to read the conversation.
  await page.keyboard.press('Escape')
  await page.evaluate((hash) => { window.location.hash = hash }, `#/p/${project.id}/general/m/${message.id}`)
  await expect(page.getByRole('heading', { name: '# General' })).toBeVisible()
  await expectContained(page)
  await page.locator(`[data-message-id="${message.id}"]`).getByRole('button', { name: /Task: Pruning heads/ }).click()
  const phoneDetail = page.getByRole('complementary', { name: 'Task details' })
  await expect(phoneDetail).toBeVisible()
  await expect(page.getByRole('log', { name: 'Messages' })).toBeHidden()
  await expectContained(page)
  await phoneDetail.getByRole('button', { name: 'Close details' }).first().click()
  await expect(page.getByRole('log', { name: 'Messages' })).toBeVisible()
  await expectContained(page)

  // Files and Git open on request and are dismissed again, as an overlay on a phone.
  await page.getByRole('button', { name: 'Toggle context panel' }).click()
  await expect(page.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-pressed', 'false')

  // An agent's profile is a detail screen too, with a way back.
  await page.getByRole('button', { name: 'Toggle sessions' }).click()
  await workspaceNav(page).getByRole('button', { name: 'Members' }).click()
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible()
  await page.locator('.kubecode-members-view').getByRole('button', { name: 'General', exact: true }).click()
  const profile = page.getByRole('complementary', { name: 'General' })
  await expect(profile).toBeVisible()
  await expectContained(page)
  await profile.getByRole('button', { name: 'Close details' }).click()
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible()
})
