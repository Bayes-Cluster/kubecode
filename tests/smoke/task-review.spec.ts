import { writeFile } from 'node:fs/promises'

import { expect, test, type Page } from '@playwright/test'

import { MemberAgent } from './agents'
import { closeNavigationSheet, inspector, workspaceNav } from './shell'
import { seedTaskInReview } from './taskFixtures'

/**
 * Reviewing a Task's results against the real Runtime (#218, ADR 0230): one
 * lifecycle on a phone and a desktop board, sending work back with feedback
 * that reaches General, a read that failed never counting as a look at
 * changed evidence, acceptance only at the version that was shown, Discuss in
 * General with the Task's scope (over the Task on a phone, beside it on a
 * desktop), and archiving apart from accepting. The
 * Task is admitted and started by the researcher's own words (taskFixtures).
 */

async function expectContained(page: Page) {
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
}

const stageGroup = (page: Page) => page.getByRole('tablist', { name: 'Stage' })
const column = (page: Page, stage: string) => page.getByRole('region', { name: stage, exact: true })

test('@smoke a Task is reviewed at the version that was shown, sent back through General, and archived apart from accepting', async ({ page, request }) => {
  test.setTimeout(300_000)
  const requested = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741')
  const workspaceUrl = requested.pathname === '/'
    ? `${requested.origin}/user/local/kubecode`
    : requested.href.replace(/\/$/, '')
  const api = `${workspaceUrl}/api/v1`
  const projectName = `kubecode-review-${Date.now()}`
  const projectPath = `/tmp/${projectName}`
  let projectId: string | undefined

  try {
    const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: projectPath } })
    expect(created.ok(), await created.text()).toBe(true)
    projectId = (await created.json() as { id: string }).id
    const seed = await seedTaskInReview(request, { api, projectId, projectPath, laterMessages: 0 })
    const members = await (await request.get(`${api}/projects/${projectId}/members`)).json() as {
      members: Array<{ role: string; public_conversation_id: string | null }>
    }
    const manager = new MemberAgent(
      request,
      members.members.find((member) => member.role === 'general')?.public_conversation_id as string,
    )
    const card = page.getByTestId(`task-card-${seed.taskId}`)

    // 1. On a phone, the board is one lifecycle shown one stage at a time, contained.
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(`${workspaceUrl}/#/p/${projectId}/board`)
    await closeNavigationSheet(page)
    await expect(page.getByRole('heading', { name: 'Kanban', level: 2 })).toBeVisible()
    await expect(stageGroup(page).getByRole('tab', { name: 'Review · 1' })).toHaveAttribute('aria-selected', 'true')
    await expect(column(page, 'Ready')).toBeHidden()
    await expect(page.locator('[draggable="true"]')).toHaveCount(0)
    await expectContained(page)

    // 2. The Task is a screen of its own; evidence opens over it, and Back returns to it.
    await expect(card).toContainText('Review results')
    await card.click()
    const task = inspector(page, 'Task details')
    await expect(task.getByRole('button', { name: 'Back to Kanban' })).toBeVisible()
    const review = task.getByRole('region', { name: 'Results for your review' })
    await expect(review.getByText('Pruning heads kept accuracy at 0.91')).toBeVisible()
    // On a phone the decision stays together and in view at the bottom of the Task.
    await expect(review.getByRole('group', { name: 'Your decision' })).toBeInViewport()
    await expect(task.getByRole('group', { name: 'What happens next' }).getByRole('button', { name: 'Discuss in General' })).toBeVisible()
    await expectContained(page)
    await review.getByRole('button', { name: /results\.csv/ }).click()
    const evidence = inspector(page, 'Evidence details')
    await expect(evidence.getByText(/^Showing version /)).toBeVisible()
    await expectContained(page)
    await evidence.getByRole('button', { name: `Back to ${seed.taskTitle}` }).click()
    await expect(evidence).toHaveCount(0)

    // 2b. On a phone, Discuss in General replaces the Task with General narrowed to it; Back returns to the Task.
    await task.getByRole('button', { name: 'Discuss in General' }).click()
    await expect.poll(() => page.url()).toContain(`filter=${seed.taskId}`)
    await expect(task).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show everything' })).toBeVisible()
    await expectContained(page)
    await page.goBack()
    await expect.poll(() => page.url()).toContain(`/board?task=${seed.taskId}`)
    await expect(task.getByRole('region', { name: 'Results for your review' })).toBeVisible()
    await expect(task.getByRole('button', { name: 'Back to Kanban' })).toBeVisible()

    // 3. Sending back needs feedback; it reaches General, and the card follows its Task to In progress.
    const sendBack = review.getByRole('button', { name: 'Send back' })
    await expect(sendBack).toBeDisabled()
    await sendBack.scrollIntoViewIfNeeded()
    await expect(sendBack).toBeInViewport()
    await review.getByLabel('Feedback for the team').fill('Rerun it against the new baseline.')
    await sendBack.click()
    await expect(task.getByText(/^Sent back\. The General Agent was told in General, with your feedback\./)).toBeVisible()
    await task.getByRole('button', { name: 'Back to Kanban' }).click()
    await expect(stageGroup(page).getByRole('tab', { name: 'In progress · 1' })).toHaveAttribute('aria-selected', 'true')
    await expect(card).toBeFocused()
    await expectContained(page)
    const recent = await manager.call<Array<{ body: string; author: string }>>('general_recent', { limit: 10 })
    expect(recent.some((message) => message.body.includes('Rerun it against the new baseline.'))).toBe(true)

    // 4. The manager asks again; the evidence then changes to bytes that cannot be shown.
    await manager.call('task_request_review', {
      research_id: seed.taskId,
      summary: 'Rerun at the new baseline: accuracy 0.50.',
      evidence: ['file:results.csv'],
    })
    await writeFile(`${projectPath}/results.csv`, Buffer.from([0xff, 0xfe, 0x00]))
    await page.setViewportSize({ width: 1440, height: 900 })
    // The phone Sheet never changed the wide-screen layout: the navigation is a column again.
    await expect(workspaceNav(page)).toBeVisible()
    await workspaceNav(page).getByRole('button', { name: /^Kanban/ }).click()
    await expect(page.locator('[draggable="true"]')).toHaveCount(0)
    await card.click()
    await expect(task.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')
    await expect(review.getByText('Rerun at the new baseline: accuracy 0.50.')).toBeVisible()
    // 4b. In the desktop inspector the header keeps the Task's title and menu; Discuss sits with what happens next,
    // and the decision stays inside the panel.
    const heading = await task.getByRole('heading', { name: seed.taskTitle, level: 3 }).boundingBox()
    expect(heading?.width ?? 0).toBeGreaterThan(160)
    await expect(task.getByRole('group', { name: 'What happens next' }).getByRole('button', { name: 'Discuss in General' })).toBeVisible()
    const panelBox = await task.boundingBox()
    const decisionBox = await review.getByRole('group', { name: 'Your decision' }).boundingBox()
    expect((decisionBox?.x ?? 0) + (decisionBox?.width ?? 0)).toBeLessThanOrEqual((panelBox?.x ?? 0) + (panelBox?.width ?? 0) + 1)

    // 5. Archiving is apart from accepting, and refused with a reason while a review is open.
    await task.getByRole('button', { name: 'More actions for this Task' }).click()
    await page.getByRole('menuitem', { name: 'Archive Task' }).click()
    const blocked = page.getByRole('alertdialog', { name: 'This Task can\'t be archived now' })
    await expect(blocked.getByText('Decide its review first: accept the results or send them back.')).toBeVisible()
    await blocked.getByRole('button', { name: 'Cancel' }).click()

    // 6. A read that failed never counts as a look: the version cannot be accepted.
    await expect(review.getByRole('button', { name: /results\.csv/ })).toHaveAccessibleName(/Changed since cited/)
    const accept = review.getByRole('button', { name: 'Accept the version you saw' })
    await expect(accept).toBeDisabled()
    await review.getByRole('button', { name: 'Look at it' }).click()
    await expect(evidence.getByRole('alert')).toContainText('Could not load this record.')
    await expect(evidence.getByText(/This version could not be shown, so it can't be accepted/)).toBeVisible()
    await evidence.getByRole('button', { name: /^Back to / }).click()
    await expect(review.getByRole('button', { name: 'Look at it' })).toBeFocused()
    await expect(accept).toBeDisabled()
    await expect(accept).toHaveAccessibleDescription(/A read that failed does not count/)

    // 7. Once a version is shown, that version — and only it — is accepted.
    await writeFile(`${projectPath}/results.csv`, 'accuracy\n0.50\n')
    await review.getByRole('button', { name: 'Look at it' }).click()
    await expect(evidence.getByText(/^Showing version /)).toBeVisible()
    await evidence.getByRole('button', { name: /^Back to / }).click()
    await expect(accept).toBeEnabled()
    await accept.click()
    await expect(review.getByText('Changed since cited')).toHaveCount(0)
    // Arrow keys move and select within the outcome RadioGroup (held like a real key).
    await review.getByRole('radio', { name: 'Supports the hypothesis' }).click()
    await page.keyboard.press('ArrowDown', { delay: 50 })
    await expect(review.getByRole('radio', { name: 'Valid negative result' })).toBeChecked()
    await expect(review.getByRole('radio', { name: 'Valid negative result' })).toBeFocused()
    await review.getByRole('radio', { name: 'Inconclusive' }).check()
    await review.getByRole('button', { name: 'Accept results' }).click()
    await expect(task.getByText(/^Accepted as Inconclusive\. The General Agent was told in General\./)).toBeVisible()
    await expect(column(page, 'Done').getByTestId(`task-card-${seed.taskId}`)).toBeVisible()

    // 8. Discuss in General: General narrowed to the Task, composer ready, the Task beside it.
    await task.getByRole('button', { name: 'Discuss in General' }).click()
    await expect.poll(() => page.url()).toContain(`filter=${seed.taskId}`)
    await expect(page.getByLabel('Message the Workspace')).toBeFocused()
    await expect(page.getByRole('button', { name: 'Show everything' })).toBeVisible()
    await expect(task).toBeVisible()
    await page.goBack()
    await expect.poll(() => page.url()).toContain(`/board?task=${seed.taskId}`)

    // 9. Closing the Task returns to its card, in the column it moved to.
    await task.getByRole('button', { name: 'Close details' }).first().click()
    await expect(card).toBeFocused()

    // 10. A Done Task can be archived; it leaves the board and comes back from the archived list.
    await card.click()
    await task.getByRole('button', { name: 'More actions for this Task' }).click()
    await page.getByRole('menuitem', { name: 'Archive Task' }).click()
    const confirm = page.getByRole('alertdialog', { name: `Archive “${seed.taskTitle}”?` })
    await confirm.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(task.getByText('Archived. It is off the board; restore it to continue.')).toBeVisible()
    await page.getByText('Archived (1)').click()
    await expect(page.locator('.kubecode-task-archived').getByRole('button', { name: /Pruning heads/ })).toContainText('Inconclusive')
    await task.getByRole('button', { name: 'Restore to the board' }).click()
    await expect(column(page, 'Done').getByTestId(`task-card-${seed.taskId}`)).toBeVisible()
    await expect(page.getByText('Archived (1)')).toHaveCount(0)
  } finally {
    if (projectId) await request.delete(`${api}/projects/${projectId}`)
  }
})
