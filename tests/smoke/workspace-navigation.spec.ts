import { expect, test, type Page } from '@playwright/test'

import { closeNavigationSheet, expectUrl, inspector, openGeneral, selectWorkspace, toggleNavigation, workspaceNav } from './shell'
import { seedTaskInReview } from './taskFixtures'

/**
 * Workspace places and the inspector stack (ADR 0228) against the real Runtime
 * under the non-root base path: a new Workspace opens General, and so does one
 * that already has a Session; each Workspace comes back to its own place;
 * General → Task → evidence → Back returns to the same message with the unsent
 * draft intact, on a desktop and on a 390px phone, with the in-app Back and the
 * browser's; General's Task filter and the scroll of Kanban, Resources and
 * Members survive a round trip; a member and a resource open in the inspector
 * beside the view; links written before still resolve; and no unrelated
 * Session ever opens on the way.
 */

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
}

async function addProject(page: Page, projectPath: string, projectName: string) {
  await page.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('combobox', { name: 'Full path on this server' }).fill(projectPath)
  await page.getByRole('option', { name: `Create ${projectPath}` }).click()
  await expect(page.getByRole('list', { name: 'Workspaces' }).getByRole('button', { name: projectName, exact: true })).toBeVisible({ timeout: 20_000 })
}

/**
 * Scrolls a view's scroller part of the way down, clear of the bottom (which is
 * remembered as "at the end"), and reports where it stopped; it must be able to
 * scroll, or the round trip would prove nothing.
 */
async function scrollPartWay(page: Page, selector: string): Promise<number> {
  const scroller = page.locator(selector).first()
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(80)
  const top = await scroller.evaluate((element) => {
    element.scrollTop = Math.min(120, element.scrollHeight - element.clientHeight - 64)
    element.dispatchEvent(new Event('scroll'))
    return element.scrollTop
  })
  expect(top).toBeGreaterThan(0)
  // The position is recorded on the next frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return top
}

async function scrollOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((element) => element.scrollTop)
}

/** Whether the Sessions surface was ever on screen since the flag was last cleared. */
async function sessionSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as unknown as { __sessionSeen?: boolean }).__sessionSeen))
}

test('@smoke workspace navigation returns to each place, through the inspector stack, on a desktop and a phone', async ({ page, request }) => {
  test.setTimeout(300_000)
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const api = `${workspaceUrl}/api/v1`
  const stamp = Date.now()
  const firstName = `kubecode-places-${stamp}`
  const secondName = `kubecode-places-other-${stamp}`
  const registered: string[] = []
  const projectIdOf = async (name: string) => {
    const projects = await (await request.get(`${api}/projects`)).json() as Array<{ id: string; name: string }>
    const id = projects.find((candidate) => candidate.name === name)?.id
    if (!id) throw new Error(`${name} was not registered`)
    registered.push(id)
    return id
  }

  // Records whether the Sessions surface is ever drawn, however briefly.
  await page.addInitScript(() => {
    const look = () => {
      if (document.querySelector('[data-testid="agent-session-workspace"]')) {
        (window as unknown as { __sessionSeen?: boolean }).__sessionSeen = true
      }
    }
    new MutationObserver(look).observe(document, { childList: true, subtree: true })
  })

  try {
    // A second Workspace that already has a Session: entering it must still open General.
    const otherPath = `/tmp/${secondName}`
    const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: otherPath } })
    expect(created.ok(), await created.text()).toBe(true)
    const otherId = (await created.json() as { id: string }).id
    registered.push(otherId)
    const otherSession = await request.post(`${api}/projects/${otherId}/sessions`, {
      data: { agent_id: 'opencode', title: 'Other execution' },
    })
    expect(otherSession.ok(), await otherSession.text()).toBe(true)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(workspaceUrl)

    // 1. A new Workspace opens General, with no way "back" and execution history out of the way.
    await addProject(page, `/tmp/${firstName}`, firstName)
    const projectId = await projectIdOf(firstName)
    await page.evaluate(() => { (window as unknown as { __sessionSeen?: boolean }).__sessionSeen = false })
    await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#/p/${projectId}/general$`))
    await expect(page.getByRole('button', { name: /back to sessions|^back$/i })).toHaveCount(0)
    const mainPane = page.locator('.kubecode-session-context-row')
    for (const role of ['button', 'link'] as const) {
      await expect(mainPane.getByRole(role, { name: /^back\b|sessions/i }).and(page.locator(':not([aria-pressed])'))).toHaveCount(0)
    }
    await expect(page.locator('.kubecode-history-nav')).toHaveJSProperty('open', false)
    const nav = workspaceNav(page)
    const order = await Promise.all([
      nav.getByRole('button', { name: 'General' }).first(),
      nav.getByRole('button', { name: /^Kanban/ }),
      nav.getByRole('button', { name: 'Resources' }),
      nav.locator('summary', { hasText: 'Needs you' }),
      nav.getByRole('button', { name: 'Members' }),
    ].map(async (entry) => (await entry.boundingBox())?.y ?? Number.NaN))
    expect(order).toEqual([...order].sort((a, b) => a - b))

    // 2. A Task in review, cited by a message in the middle of a long conversation.
    const seed = await seedTaskInReview(request, { api, projectId, projectPath: `/tmp/${firstName}` })
    const log = page.getByRole('log', { name: 'Messages' })
    const cited = page.locator(`[data-message-id="${seed.citingMessageId}"]`)
    await expect(log.getByText('Later note 30 about the sweep schedule.')).toBeVisible({ timeout: 30_000 })
    await cited.scrollIntoViewIfNeeded()
    await expect(cited).toBeInViewport()
    const draft = 'An unsent thought about pruning heads'
    const composer = page.getByLabel('Message the Workspace')
    await composer.fill(draft)

    // 3. The Task opens beside the conversation; the draft stays.
    await cited.getByRole('button', { name: 'Task Pruning heads' }).click()
    const task = inspector(page, 'Task details')
    await expect(task).toBeVisible()
    await expect(page.locator('.kubecode-session-context-row')).toHaveAttribute('data-inspector-layout', 'side')
    await expect(composer).toHaveValue(draft)
    await expectUrl(page, `/general/m/${seed.citingMessageId}?task=${seed.taskId}`)
    const review = task.getByRole('region', { name: 'Results for your review' })
    await expect(review.getByText('Pruning heads kept accuracy at 0.91')).toBeVisible()
    const outcome = review.getByRole('radio', { name: 'Valid negative result' })
    await outcome.check()

    // 4. Evidence opens over the Task; its address is shareable.
    await review.getByRole('button', { name: new RegExp(seed.evidenceTitle) }).click()
    const evidence = inspector(page, 'Evidence details')
    await expect(evidence).toBeVisible()
    await expectUrl(page, `inspect=evidence~research~${seed.evidenceId}`)

    // 5. Back returns to the Task as it was left, focus on the evidence that was opened.
    await evidence.getByRole('button', { name: /^Back to / }).click()
    await expect(task).toBeVisible()
    await expect(outcome).toBeChecked()
    await expect(review.getByRole('button', { name: new RegExp(seed.evidenceTitle) })).toBeFocused()

    // 6. Closing lands on the message, with the draft and the reading place intact.
    await task.getByRole('button', { name: 'Close details' }).first().click()
    await expect(page.getByRole('complementary', { name: 'Task details' })).toHaveCount(0)
    await expect(cited).toBeFocused()
    await expect(cited).toBeInViewport()
    await expect(composer).toHaveValue(draft)
    await expect(page).toHaveURL(new RegExp(`/general/m/${seed.citingMessageId}$`))

    // 7. Kanban and back: the same draft, the same part of the conversation.
    await nav.getByRole('button', { name: /^Kanban/ }).click()
    await expect(page.getByRole('region', { name: 'Kanban', exact: true })).toBeVisible()
    await openGeneral(page)
    await expect(composer).toHaveValue(draft)
    await expect(cited).toBeInViewport()
    await expect(page).toHaveURL(/\/general\/m\/[^?]+$/)

    // 7a. General's Task filter survives a round trip; clearing it brings back the unfiltered draft.
    const taskFilter = page.getByLabel('Show messages about')
    await taskFilter.selectOption({ label: seed.taskTitle })
    await expectUrl(page, `filter=${seed.taskId}`)
    await nav.getByRole('button', { name: 'Resources' }).click()
    await expect(page.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
    await openGeneral(page)
    await expect(taskFilter).toHaveValue(seed.taskId)
    await expectUrl(page, `filter=${seed.taskId}`)
    await taskFilter.selectOption({ label: 'Everything' })
    await expect(composer).toHaveValue(draft)
    await expect(page).toHaveURL(/\/general(\/m\/[^?]+)?$/)

    // 7b. A member's profile and a cited resource each open in the inspector beside General.
    const notes = await request.post(`${api}/projects/${projectId}/research/${seed.evidenceId}/imports`, {
      data: { origin: 'paste', label: 'Sweep notes', content: 'Heads 3 and 7 matter most.', client_request_id: `notes-${stamp}` },
    })
    expect(notes.ok(), await notes.text()).toBe(true)
    const importId = (await notes.json() as { id: string }).id
    const posted = await request.post(`${api}/projects/${projectId}/channels/${seed.channelId}/messages`, {
      data: { body: 'The sweep notes are attached.', client_message_id: `notes-message-${stamp}`, references: [{ kind: 'import', id: importId }] },
    })
    expect(posted.ok(), await posted.text()).toBe(true)
    const notesMessage = page.locator(`[data-message-id="${(await posted.json() as { id: string }).id}"]`)
    const members = await (await request.get(`${api}/projects/${projectId}/members`)).json() as {
      members: Array<{ name: string; role: string }>
    }
    const managerName = members.members.find((member) => member.role === 'general')?.name
    if (!managerName) throw new Error('the Workspace has no General Agent')
    await nav.getByRole('list', { name: 'Agents' }).getByRole('button', { name: managerName, exact: true }).click()
    await expect(inspector(page, managerName)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
    await expectUrl(page, 'inspect=member~')
    await inspector(page, managerName).getByRole('button', { name: 'Close details' }).click()
    await expect(notesMessage).toBeVisible({ timeout: 30_000 })
    await notesMessage.getByRole('list', { name: 'References' }).getByRole('button', { name: /Imported discussion/ }).click()
    const resource = inspector(page, 'Resource details')
    await expect(resource).toBeVisible()
    await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
    await expect(page.locator('.kubecode-session-context-row')).toHaveAttribute('data-inspector-layout', 'side')
    await expectUrl(page, `inspect=resource~import~${importId}`)
    await resource.getByRole('button', { name: 'Close details' }).click()
    await expect(page.getByRole('complementary', { name: 'Resource details' })).toHaveCount(0)

    // 7c. Resources opens a row in its own inspector, beside the list.
    await nav.getByRole('button', { name: 'Resources' }).click()
    await page.getByRole('option', { name: /Sweep notes/ }).click()
    await page.getByRole('region', { name: 'Project work preview' }).getByRole('button', { name: 'Open' }).click()
    await expect(inspector(page, 'Resource details')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
    await inspector(page, 'Resource details').getByRole('button', { name: 'Close details' }).click()

    // 7d. Kanban, Resources and Members each come back scrolled where they were left (a
    // short, narrow window, where the board's columns pair up and every list overflows).
    for (let index = 0; index < 8; index += 1) {
      const more = await request.post(`${api}/projects/${projectId}/research/${seed.evidenceId}/imports`, {
        data: { origin: 'paste', label: `Sweep log ${index + 1}`, content: `Run ${index + 1}.`, client_request_id: `log-${stamp}-${index}` },
      })
      expect(more.ok(), await more.text()).toBe(true)
    }
    await page.setViewportSize({ width: 900, height: 240 })
    await closeNavigationSheet(page)
    const go = async (view: string | RegExp) => {
      await toggleNavigation(page)
      await workspaceNav(page).getByRole('button', { name: view }).first().click()
      await closeNavigationSheet(page)
    }
    for (const [view, scroller] of [
      [/^Kanban/, '.kubecode-task-board'],
      ['Resources', '[data-testid="project-work-results"]'],
      ['Members', '.kubecode-members-view'],
    ] as const) {
      await go(view)
      const left = await scrollPartWay(page, scroller)
      await go('General')
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
      await go(view)
      await expect.poll(() => scrollOf(page, scroller)).toBe(left)
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    // The sheet was put away on the narrow window; on a wide one the navigation is a column again.
    await toggleNavigation(page)
    await expect(workspaceNav(page)).toBeVisible()
    await openGeneral(page)
    await expect(composer).toHaveValue(draft)

    // 8. The browser's Back walks the inspector stack one level at a time.
    await cited.getByRole('button', { name: 'Task Pruning heads' }).click()
    await expect(task).toBeVisible()
    await review.getByRole('button', { name: new RegExp(seed.evidenceTitle) }).click()
    await expect(evidence).toBeVisible()
    await page.goBack()
    await expect(task).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Evidence details' })).toHaveCount(0)
    await page.goBack()
    await expect(page.getByRole('complementary', { name: 'Task details' })).toHaveCount(0)
    await expect(composer).toHaveValue(draft)

    // 9. The second Workspace opens General, never its Session; the first comes back to its own place and draft.
    await selectWorkspace(page, secondName)
    await expect(page).toHaveURL(new RegExp(`#/p/${otherId}/general$`))
    await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()
    await expect(composer).toHaveValue('')
    expect(await sessionSeen(page)).toBe(false)
    await selectWorkspace(page, firstName)
    await expect(page).toHaveURL(new RegExp(`#/p/${projectId}/general/m/[^?]+$`))
    await expect(composer).toHaveValue(draft)
    await expect(cited).toBeInViewport()

    // 10. A reload with a three-level link restores the Task and its evidence.
    await page.goto(`${workspaceUrl}/#/p/${projectId}/general/m/${seed.citingMessageId}?task=${seed.taskId}&inspect=evidence~research~${seed.evidenceId}`)
    await expect(inspector(page, 'Evidence details')).toBeVisible()
    await page.getByRole('complementary', { name: 'Evidence details' }).getByRole('button', { name: /^Back to / }).click()
    await expect(inspector(page, 'Task details')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/general/m/${seed.citingMessageId}\\?task=${seed.taskId}$`))
    expect(page.url()).toContain('/user/local/kubecode')

    // 11. On a phone the inspector is a screen of its own over the parked conversation.
    await page.setViewportSize({ width: 390, height: 800 })
    // The navigation is a sheet over the view on a phone; put it away (Escape would pop the inspector).
    await closeNavigationSheet(page)
    await page.getByRole('complementary', { name: 'Task details' }).getByRole('button', { name: 'Back to General' }).click()
    await expect(log).toBeVisible()
    const phoneDraft = 'Thumbs say: check the heads'
    await composer.fill(phoneDraft)
    await expectContained(page)
    await cited.getByRole('button', { name: 'Task Pruning heads' }).click()
    const phoneTask = inspector(page, 'Task details')
    await expect(phoneTask).toBeVisible()
    await expect(log).toBeHidden()
    await expect(phoneTask.getByRole('button', { name: 'Back to General' })).toBeVisible()
    await expect(phoneTask.getByRole('button', { name: 'Close details' })).toHaveCount(0)
    await expectContained(page)
    await phoneTask.getByRole('region', { name: 'Results for your review' })
      .getByRole('button', { name: new RegExp(seed.evidenceTitle) }).click()
    const phoneEvidence = inspector(page, 'Evidence details')
    await expect(phoneEvidence).toBeVisible()
    await expect(phoneEvidence.getByRole('button', { name: 'Close details' })).toHaveCount(0)
    await expectContained(page)
    // The in-app Back leaves the evidence for the Task, one level.
    await phoneEvidence.getByRole('button', { name: `Back to ${seed.taskTitle}` }).click()
    await expect(phoneTask).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Evidence details' })).toHaveCount(0)
    // So does the browser's.
    await phoneTask.getByRole('region', { name: 'Results for your review' })
      .getByRole('button', { name: new RegExp(seed.evidenceTitle) }).click()
    await expect(phoneEvidence).toBeVisible()
    await page.goBack()
    await expect(phoneTask).toBeVisible()
    await phoneTask.getByRole('button', { name: 'Back to General' }).click()
    await expect(log).toBeVisible()
    await expect(cited).toBeFocused()
    await expect(composer).toHaveValue(phoneDraft)
    await expectContained(page)

    // Nothing on the way opened a Session.
    expect(await sessionSeen(page)).toBe(false)

    // 12. Links written before ADR 0228 still resolve, under the base path.
    await page.setViewportSize({ width: 1440, height: 900 })
    const session = await (await request.post(`${api}/projects/${projectId}/sessions`, {
      data: { agent_id: 'opencode', title: 'Earlier execution' },
    })).json() as { id: string }
    const channelThread = await (await request.post(`${api}/projects/${projectId}/channels/${seed.channelId}/threads`, {
      data: { root_message_id: seed.citingMessageId },
    })).json() as { id: string }
    const roster = await (await request.get(`${api}/projects/${projectId}/members`)).json() as {
      members: Array<{ id: string; name: string; role: string }>
    }
    const manager = roster.members.find((member) => member.role === 'general')
    if (!manager) throw new Error('the Workspace has no General Agent')

    await page.goto(`${workspaceUrl}/#/p/${projectId}/sessions/c/${session.id}`)
    await expect(page.getByTestId('agent-session-workspace')).toBeVisible()
    await expectUrl(page, `/sessions/c/${session.id}`)
    await page.goto(`${workspaceUrl}/#/p/${projectId}/general?thread=${channelThread.id}`)
    await expect(page.getByRole('complementary', { name: 'Earlier thread' })).toBeVisible()
    await page.goto(`${workspaceUrl}/#/p/${projectId}/members?member=${manager.id}`)
    await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible()
    await expect(inspector(page, manager.name)).toBeVisible()
    expect(page.url()).toContain('/user/local/kubecode/')
  } finally {
    // Projects are only unregistered; their directories stay with the test machine's /tmp.
    for (const id of registered) await request.delete(`${api}/projects/${id}`)
  }
})
