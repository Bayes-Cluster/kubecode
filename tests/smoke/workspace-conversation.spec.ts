import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { MemberAgent, promptsOf, waitForPrompt } from './agents'
import { closeNavigationSheet, openGeneral, selectWorkspace, workspaceNav } from './shell'

/**
 * General against the real Runtime under a non-root base path (ADR 0229):
 * plain messages with visible recipients, mentions by member, identity that
 * survives a Session replacement, one public reply, drafts kept per place and
 * across a failed send, earlier Threads read-only, and private conversations
 * that reach General only through the previewed share. The members are
 * deterministic fixtures acting through their own MCP endpoints (agents.ts).
 */

type Roster = {
  members: Array<{
    id: string; name: string; handle: string; role: string
    public_conversation_id: string | null; dm_conversation_id: string | null
  }>
}

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

async function createProject(request: APIRequestContext, api: string, name: string): Promise<string> {
  const created = await request.post(`${api}/projects`, { data: { kind: 'create', path: `/tmp/${name}` } })
  expect(created.ok(), await created.text()).toBe(true)
  return (await created.json() as { id: string }).id
}

async function roster(request: APIRequestContext, api: string, projectId: string): Promise<Roster> {
  return (await (await request.get(`${api}/projects/${projectId}/members`)).json()) as Roster
}

const composer = (page: Page) => page.getByRole('combobox', { name: 'Message the Workspace' })
const log = (page: Page) => page.getByRole('log', { name: 'Messages' })
const row = (page: Page, text: string) => page.locator('article[data-message-id]').filter({ hasText: text })
const toRow = (page: Page) => page.locator('.kubecode-composer-to')

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(log(page).getByText(text, { exact: true })).toBeVisible()
}

test.describe('on a desktop', () => {
  // A mouse: Reply shows on hover beside More (the default project emulates touch).
  test.use({ hasTouch: false })

  test('@smoke General names its members, routes by mention and reply, keeps drafts, and keeps private text private', async ({ page, request }) => {
    test.setTimeout(240_000)
    const { api, workspaceUrl } = urls()
    const stamp = Date.now()
    const projectName = `kubecode-conversation-${stamp}`
    const otherName = `kubecode-conversation-other-${stamp}`
    const registered: string[] = []
    try {
      const projectId = await createProject(request, api, projectName)
      registered.push(projectId)
      registered.push(await createProject(request, api, otherName))
      await expect.poll(async () => (await roster(request, api, projectId)).members.filter((member) => member.role === 'general').length).toBe(1)
      const manager = (await roster(request, api, projectId)).members.find((member) => member.role === 'general')!
      for (const [name, template] of [['Analyst', 'analysis'], ['Writer', 'writing']]) {
        const created = await request.post(`${api}/projects/${projectId}/members`, {
          data: { name, template, client_request_id: `${name}-${stamp}` },
        })
        expect(created.ok(), await created.text()).toBe(true)
      }
      const members = await roster(request, api, projectId)
      const analyst = members.members.find((member) => member.handle === 'analyst')!
      const writer = members.members.find((member) => member.handle === 'writer')!

      await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
      await expect(page.getByRole('heading', { name: 'General', exact: true, level: 2 })).toBeVisible()

      // 1. No message types and no To row in the card: a message that names no one goes to the
      //    project manager, as the sent message says.
      await expect(page.getByRole('combobox', { name: 'Message type' })).toHaveCount(0)
      await expect(toRow(page)).toHaveCount(0)
      await send(page, 'Should we prune the attention heads?')
      await expect(row(page, 'Should we prune the attention heads?')).toHaveAttribute('aria-label', 'You')
      await expect(row(page, 'Should we prune the attention heads?').locator('.kubecode-message-recipients')).toContainText(manager.name)
      // One input surface (#232): the text and its controls in the Prompt Input card, whom it reaches in its footer;
      // the researcher's own message reads as theirs.
      const promptCard = page.getByTestId('conversation-prompt-input')
      await expect(promptCard.getByRole('combobox', { name: 'Message the Workspace' })).toBeVisible()
      await expect(promptCard.getByRole('button', { name: 'Add context' })).toBeVisible()
      await expect(promptCard.locator('.kubecode-composer-to')).toHaveCount(0)
      await expect(promptCard).not.toContainText('never start work')
      await expect(row(page, 'Should we prune the attention heads?')).toHaveAttribute('data-from', 'self')
      // Reached by keyboard, the card shows a focus ring (#229).
      await composer(page).focus()
      await expect(promptCard.locator("[data-slot='input-group']")).not.toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
      await waitForPrompt(manager.public_conversation_id!, (text) => text.includes('Should we prune the attention heads?'))

      // 2. Mentioning a member by @ shows them as the recipient, and only they are prompted.
      await composer(page).pressSequentially('@ana')
      await expect(page.getByRole('option', { name: /Specialist · Analysis/ })).toBeVisible()
      await composer(page).press('Enter')
      await expect(composer(page)).toHaveValue('@analyst ')
      await composer(page).pressSequentially('please size the sweep')
      await expect(composer(page)).toHaveValue('@analyst please size the sweep')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(log(page).getByText('@analyst please size the sweep')).toBeVisible()
      await expect(row(page, '@analyst please size the sweep').locator('.kubecode-message-recipients')).toContainText('Analyst')
      await waitForPrompt(analyst.public_conversation_id!, (text) => text.includes('please size the sweep'))
      expect(promptsOf(manager.public_conversation_id!).some((text) => text.includes('please size the sweep'))).toBe(false)
      await send(page, '@writer please draft the outline')
      await waitForPrompt(writer.public_conversation_id!, (text) => text.includes('please draft the outline'))

      // 3. General and two specialists stay distinct, also after a Session is replaced.
      await new MemberAgent(request, analyst.public_conversation_id!).call('general_post', { body: 'Sweep sized: twelve runs.' })
      await new MemberAgent(request, writer.public_conversation_id!).call('general_post', { body: 'Outline drafted.' })
      await new MemberAgent(request, manager.public_conversation_id!).call('general_post', { body: 'Noted, tracking both.' })
      const replaced = await request.post(`${api}/projects/${projectId}/members/${analyst.id}/session`, { data: {} })
      expect(replaced.ok(), await replaced.text()).toBe(true)
      const newAnalystSession = (await replaced.json() as { public_conversation_id: string }).public_conversation_id
      expect(newAnalystSession).not.toBe(analyst.public_conversation_id)
      await expect(row(page, 'Sweep sized: twelve runs.')).toHaveAttribute('aria-label', 'Analyst')
      await expect(row(page, 'Outline drafted.')).toHaveAttribute('aria-label', 'Writer')
      await expect(row(page, 'Noted, tracking both.')).toHaveAttribute('aria-label', manager.name)
      // A member's next one-line message sits tight under the last (#229): no blank header row.
      await new MemberAgent(request, manager.public_conversation_id!).call('general_post', { body: 'And one more.' })
      await expect(row(page, 'And one more.')).toHaveAttribute('data-continued', 'true')
      expect((await row(page, 'And one more.').boundingBox())!.height).toBeLessThanOrEqual(40)
      await expect(row(page, '@writer please draft the outline')).toContainText('Writer')

      // A chat at 1440px (ADR 0239): the thread is the middle three quarters, the composer card at most
      // half the pane and centred, the researcher's messages on the right and members' on the left.
      {
        await page.setViewportSize({ width: 1440, height: 900 })
        // The panes settle a frame or two after the viewport changes; read both boxes together until they agree.
        const boxes = async () => ({
          pane: (await page.locator('.kubecode-channel-main').boundingBox())!,
          dock: (await page.locator('.kubecode-conversation-dock').boundingBox())!,
        })
        await expect.poll(async () => {
          const { pane, dock } = await boxes()
          return dock.width <= Math.max(pane.width * 0.5, 480) + 1
            && Math.abs((dock.x - pane.x) - (pane.x + pane.width - dock.x - dock.width)) <= 2
        }, { message: 'composer dock at most half the pane and centred' }).toBe(true)
        const { pane } = await boxes()
        const threadWidth = await log(page).locator('.kubecode-channel-messages').evaluate((element) => {
          const style = getComputedStyle(element)
          return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        })
        expect(threadWidth / pane.width).toBeGreaterThan(0.7)
        expect(threadWidth / pane.width).toBeLessThan(0.8)
        const mine = (await row(page, 'Should we prune the attention heads?').boundingBox())!
        const theirs = (await row(page, 'Outline drafted.').boundingBox())!
        expect(mine.x + mine.width).toBeGreaterThan(theirs.x + theirs.width - 1)
        expect(mine.x).toBeGreaterThan(theirs.x)

        // At 2560px (ADR 0240) the card fills the dock, both centred, and the last message ends above the dock.
        await page.setViewportSize({ width: 2560, height: 1440 })
        const wideBoxes = async () => ({
          widePane: (await page.locator('.kubecode-channel-main').boundingBox())!,
          wideDock: (await page.locator('.kubecode-conversation-dock').boundingBox())!,
          card: (await page.locator('.kubecode-conversation-dock [data-testid="conversation-prompt-input"]').boundingBox())!,
        })
        await expect.poll(async () => {
          const { widePane, wideDock, card } = await wideBoxes()
          return card.width <= 960
            && Math.abs((card.x - widePane.x) - (widePane.x + widePane.width - card.x - card.width)) <= 2
            && Math.abs((wideDock.x - widePane.x) - (widePane.x + widePane.width - wideDock.x - wideDock.width)) <= 2
        }, { message: 'composer card at most 960px, card and dock centred' }).toBe(true)
        const { wideDock } = await wideBoxes()
        await log(page).locator('.kubecode-channel-messages').evaluate((element) => { element.scrollTop = element.scrollHeight })
        const last = (await page.locator('article[data-message-id]').last().boundingBox())!
        expect(last.y + last.height).toBeLessThanOrEqual(wideDock.y + 1)
        await page.setViewportSize({ width: 1440, height: 900 })
      }

      // 4. Reply cites the old message and addresses the Analyst, whose new Session gets it with the citation.
      const old = page.locator('article[data-author="agent"]').filter({ hasText: 'Sweep sized: twelve runs.' })
      await old.hover()
      await old.getByRole('button', { name: 'Reply to Analyst' }).click()
      await expect(composer(page)).toHaveValue('@analyst ')
      await expect(composer(page)).toBeFocused()
      await expect(page.getByText('Replying to Analyst: Sweep sized: twelve runs.')).toBeVisible()
      await expect(composer(page)).toHaveValue('@analyst ')
      await composer(page).pressSequentially('run all twelve')
      await expect(composer(page)).toHaveValue('@analyst run all twelve')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(log(page).getByText('@analyst run all twelve')).toBeVisible()
      await waitForPrompt(newAnalystSession, (text) => text.includes('run all twelve') && text.includes('It replies to message'))
      await new MemberAgent(request, newAnalystSession).call('general_post', { body: 'Running all twelve.' })
      await expect(row(page, 'Running all twelve.')).toHaveAttribute('aria-label', 'Analyst')
      await expect(page.locator('article[data-message-id][aria-label="Agent"]')).toHaveCount(0)
      // The citation jumps back to the original and focuses it.
      await row(page, '@analyst run all twelve').getByRole('button', { name: /In reply to Analyst: Sweep sized/ }).click()
      await expect(old).toBeFocused()

      // 5. An earlier Thread opens read-only; Reply in General cites its first message.
      const channels = await (await request.get(`${api}/projects/${projectId}/channels`)).json() as Array<{ id: string }>
      const page1 = await (await request.get(`${api}/projects/${projectId}/channels/${channels[0].id}/messages?limit=50`)).json() as {
        messages: Array<{ id: string; body: string }>
      }
      const root = page1.messages.find((message) => message.body === 'Should we prune the attention heads?')!
      const thread = await (await request.post(`${api}/projects/${projectId}/channels/${channels[0].id}/threads`, {
        data: { root_message_id: root.id },
      })).json() as { id: string }
      const threadReply = await request.post(`${api}/projects/${projectId}/channels/${channels[0].id}/messages`, {
        data: { body: 'Start with magnitude pruning', thread_id: thread.id, client_message_id: `thread-${stamp}` },
      })
      expect(threadReply.ok(), await threadReply.text()).toBe(true)
      await page.reload()
      await row(page, 'Should we prune the attention heads?').getByRole('button', { name: 'Earlier thread · 1 reply' }).click()
      const pane = page.getByRole('complementary', { name: 'Earlier thread' })
      await expect(pane.getByText(/^Read-only: .* Reply in General; only its link to a Task can change here\.$/)).toBeVisible()
      await expect(pane.getByText('Start with magnitude pruning')).toBeVisible()
      await expect(pane.getByRole('combobox', { name: 'Message the Workspace' })).toHaveCount(0)
      await expect(pane.getByRole('textbox')).toHaveCount(0)
      await pane.getByRole('button', { name: 'Reply in General' }).click()
      await expect(pane).toHaveCount(0)
      await expect(page.getByText('Replying to You: Should we prune the attention heads?')).toBeVisible()
      await page.getByRole('button', { name: 'Cancel reply' }).click()

      // 6. A draft with its Task and reply survives Kanban and another Workspace.
      const proposal = await new MemberAgent(request, manager.public_conversation_id!).call<{ research_id: string; message_id: string }>('task_propose', {
        title: 'Structured pruning',
        question: 'Does structured pruning keep accuracy?',
        success_criteria: ['accuracy within one point'],
        client_request_id: `proposal-${stamp}`,
      })
      const proposed = page.locator(`[data-message-id="${proposal.message_id}"]`)
      await expect(proposed).toBeVisible()
      await proposed.hover()
      await proposed.getByRole('button', { name: `Reply to ${manager.name}` }).click()
      await expect(composer(page)).toHaveValue('')
      await composer(page).fill('half a thought')
      const about = page.locator('[data-composer-about]')
      await expect(about).toContainText('Structured pruning')
      await workspaceNav(page).getByRole('button', { name: /^Kanban/ }).click()
      await openGeneral(page)
      await expect(composer(page)).toHaveValue('half a thought')
      await expect(about).toContainText('Structured pruning')
      await expect(page.getByText(`Replying to ${manager.name}:`, { exact: false })).toBeVisible()
      await selectWorkspace(page, otherName)
      await expect(composer(page)).toHaveValue('')
      await selectWorkspace(page, projectName)
      await expect(composer(page)).toHaveValue('half a thought')
      await expect(about).toContainText('Structured pruning')
      await expect(page.getByText(`Replying to ${manager.name}:`, { exact: false })).toBeVisible()

      // 7. A failed send stays as its own outbox row (ADR 0232 §5): the composer is
      // free, the Task stays chosen, and Send again replays the message once.
      let aborted = false
      await page.route('**/channels/*/messages', async (route) => {
        if (route.request().method() === 'POST' && !aborted) {
          aborted = true
          await route.abort()
          return
        }
        await route.continue()
      })
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const unsent = page.getByRole('list', { name: 'Unsent messages' })
      await expect(unsent.getByRole('alert')).toContainText('Not sent:')
      await expect(unsent).toContainText('half a thought')
      await expect(composer(page)).toHaveValue('')
      await expect(about).toContainText('Structured pruning')
      await unsent.getByRole('button', { name: 'Send again' }).click()
      await expect(unsent).toHaveCount(0)
      await expect(log(page).getByText('half a thought', { exact: true })).toHaveCount(1)
      await expect(composer(page)).toHaveValue('')
      await page.unroute('**/channels/*/messages')
      // The reply to the proposal is a plain message: the proposal stays off the board, and nothing private is opened.
      await expect(row(page, 'half a thought')).toContainText(manager.name)
      await expect(proposed).toContainText('Not on the board yet')
      const board = await (await request.get(`${api}/projects/${projectId}/tasks/board`)).json() as { cards: Array<{ id: string }> }
      expect(board.cards.map((card) => card.id)).not.toContain(proposal.research_id)
      expect((await roster(request, api, projectId)).members.map((member) => member.dm_conversation_id)).toEqual([null, null, null])

      // 8. A private draft never shows in General; sharing is previewed, then lands in General.
      await workspaceNav(page).getByRole('button', { name: 'Message Analyst privately' }).click()
      const dm = page.getByRole('textbox', { name: 'Message Analyst privately' })
      await dm.fill('secret plan')
      await openGeneral(page)
      await expect(composer(page)).toHaveValue('')
      await expect(log(page)).not.toContainText('secret plan')
      await workspaceNav(page).getByRole('button', { name: 'Message Analyst privately' }).click()
      await expect(dm).toHaveValue('secret plan')
      await expect(page.getByText('Only Analyst sees this message.')).toHaveCount(0)
      // The private composer follows the same rule as General's: centred, at most half the pane.
      const dmPane = (await page.locator('.kubecode-channel-main').boundingBox())!
      const dmDock = (await page.locator('.kubecode-conversation-dock').boundingBox())!
      expect(dmDock.width).toBeLessThanOrEqual(Math.max(dmPane.width * 0.5, 480) + 1)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(dm).toHaveValue('')
      await expect(page.getByRole('log').getByText('secret plan')).toBeVisible()
      await page.getByRole('button', { name: 'Share to General…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('checkbox', { name: /secret plan/ }).check()
      await dialog.getByRole('button', { name: 'Preview' }).click()
      const card = dialog.getByRole('region', { name: 'Preview' })
      await expect(card).toContainText('To')
      await expect(card).toContainText(manager.name)
      await expect(card).toContainText('like anything you write in General')
      await dialog.getByRole('button', { name: 'Post to General' }).click()
      await page.getByRole('button', { name: 'Show in General' }).click()
      await expect(page).toHaveURL(/\/general\/m\//)
      await expect(page.locator('article[data-message-id]:focus')).toContainText('secret plan')
    } finally {
      for (const id of registered) await request.delete(`${api}/projects/${id}`)
    }
  })
})

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } })

  test('@smoke General on a touch screen: More with Reply on every message, Enter breaks lines, and nothing scrolls sideways', async ({ page, request }) => {
    test.setTimeout(120_000)
    const { api, workspaceUrl } = urls()
    const projectId = await createProject(request, api, `kubecode-conversation-phone-${Date.now()}`)
    try {
      await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
      await closeNavigationSheet(page)
      await expect(composer(page)).toBeVisible()
      await expectContained(page)
      // Enter breaks the line on a touch keyboard; the arrow sends.
      await composer(page).fill('first line')
      await composer(page).press('Enter')
      await expect(composer(page)).toHaveValue('first line\n')
      await composer(page).pressSequentially('second line')
      await expect(composer(page)).toHaveValue('first line\nsecond line')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const sent = row(page, 'second line')
      await expect(sent).toBeVisible()
      await expectContained(page)
      // No hover toolbar: one persistent, touch-sized More, whose first item is Reply.
      await expect(sent.getByRole('button', { name: 'Reply to You' })).toHaveCount(0)
      const more = sent.getByRole('button', { name: "More actions for You's message" })
      await expect(more).toBeVisible()
      const box = await more.boundingBox()
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      await more.click()
      const items = page.getByRole('menuitem')
      await expect(items.first()).toHaveText('Reply')
      await items.first().click()
      await expect(page.getByText(/Replying to You:/)).toBeVisible()
      // The reply heads the same card the text is in, on a phone too.
      await expect(page.locator('.kubecode-composer-context')).toContainText('Replying to You:')
      await expectContained(page)
    } finally {
      await request.delete(`${api}/projects/${projectId}`)
    }
  })

  test('@smoke General on a phone: the own meta stays one line and Jump to latest covers no message', async ({ page, request }) => {
    test.setTimeout(180_000)
    const { api, workspaceUrl } = urls()
    const projectId = await createProject(request, api, `kubecode-conversation-latest-${Date.now()}`)
    try {
      await page.goto(`${workspaceUrl}/#/p/${projectId}/general`)
      await closeNavigationSheet(page)
      for (let index = 1; index <= 10; index += 1) {
        await composer(page).fill(`@general note ${index} that is long enough to wrap across the narrow phone thread`)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        await expect(row(page, `note ${index} that`)).toBeVisible()
      }
      // The researcher's own meta (recipient and time) is one line above the bubble (ADR 0239).
      const header = row(page, 'note 10 that').locator('.kubecode-message-self-meta')
      const time = await header.locator('time').boundingBox()
      const recipient = await header.locator('.kubecode-message-recipients').boundingBox()
      expect(Math.abs((time?.y ?? 0) - (recipient?.y ?? 100))).toBeLessThan(8)
      // Scrolled back, Jump to latest sits below the thread, over no message.
      await page.locator('.kubecode-channel-messages').evaluate((element) => { element.scrollTop = 0 })
      const latest = page.getByRole('button', { name: 'Jump to latest' })
      await expect(latest).toBeVisible()
      const button = (await latest.boundingBox())!
      const scroller = (await page.locator('.kubecode-channel-messages').boundingBox())!
      expect(button.y).toBeGreaterThanOrEqual(scroller.y + scroller.height - 1)
      await expectContained(page)
    } finally {
      await request.delete(`${api}/projects/${projectId}`)
    }
  })
})
