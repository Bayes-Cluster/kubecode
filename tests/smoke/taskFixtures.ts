import { writeFile } from 'node:fs/promises'

import { expect, type APIRequestContext } from '@playwright/test'

import { MemberAgent, waitForPrompt } from './agents'

/**
 * A Workspace with a Task waiting for the researcher's review, built through
 * the production routes and member tools (as research-workspace.spec does):
 * the researcher's own words admit and start it, and the manager asks for
 * review citing a file (`file:results.csv`, never routable) and another Task
 * (`research:<id>`, routable), then a long conversation follows in General,
 * with one researcher message that cites the Task in the middle of it.
 */
export type TaskInReview = {
  taskId: string
  taskTitle: string
  /** The other Task the review cites as evidence. */
  evidenceId: string
  evidenceTitle: string
  /** The researcher's message that cites the Task, with later messages after it. */
  citingMessageId: string
  channelId: string
}

type GeneralMessage = { id: string; author: string; body: string }

async function researcherSays(
  request: APIRequestContext,
  api: string,
  projectId: string,
  channelId: string,
  body: string,
  references: Array<{ kind: string; id: string }> = [],
): Promise<string> {
  const posted = await request.post(`${api}/projects/${projectId}/channels/${channelId}/messages`, {
    data: { body, client_message_id: `fixture-${Date.now()}-${Math.random()}`, references },
  })
  expect(posted.ok(), await posted.text()).toBe(true)
  return (await posted.json() as { id: string }).id
}

async function lastResearcherMessage(manager: MemberAgent, containing: string): Promise<string> {
  const recent = await manager.call<GeneralMessage[]>('general_recent', { limit: 40 })
  const found = [...recent].reverse().find((message) => message.author === 'researcher' && message.body.includes(containing))
  if (!found) throw new Error(`no researcher message contains: ${containing}`)
  return found.id
}

export async function seedTaskInReview(
  request: APIRequestContext,
  { api, projectId, projectPath, laterMessages = 30 }: {
    api: string
    projectId: string
    projectPath: string
    laterMessages?: number
  },
): Promise<TaskInReview> {
  await writeFile(`${projectPath}/results.csv`, 'accuracy\n0.91\n')
  const channels = await (await request.get(`${api}/projects/${projectId}/channels`)).json() as Array<{ id: string }>
  const channelId = channels[0].id
  const members = await (await request.get(`${api}/projects/${projectId}/members`)).json() as {
    members: Array<{ role: string; public_conversation_id: string | null }>
  }
  const generalConversation = members.members.find((member) => member.role === 'general')?.public_conversation_id
  if (!generalConversation) throw new Error('the Workspace has no General Agent')

  // Another Task, cited as routable evidence.
  const evidenceTitle = 'Baseline accuracy'
  const evidence = await (await request.post(`${api}/projects/${projectId}/research`, {
    data: { title: evidenceTitle, question: 'What is the baseline accuracy?', client_request_id: `baseline-${Date.now()}` },
  })).json() as { id: string }

  // The researcher's words reach the manager, who proposes the Task.
  await researcherSays(request, api, projectId, channelId, 'Let us study whether pruning heads keeps accuracy.')
  await waitForPrompt(generalConversation, (text) => text.includes('pruning heads keeps accuracy'))
  const manager = new MemberAgent(request, generalConversation)
  const taskTitle = 'Pruning heads'
  const proposal = await manager.call<{ research_id: string; revision: number }>('task_propose', {
    title: taskTitle,
    question: 'Does pruning heads keep accuracy within one point?',
    success_criteria: ['accuracy within one point of the baseline'],
    client_request_id: `proposal-${Date.now()}`,
  })
  const taskId = proposal.research_id

  // Admitted and started by the researcher's own words, never by the manager's.
  await researcherSays(request, api, projectId, channelId, 'That looks right. Please add it to the Kanban.')
  await waitForPrompt(generalConversation, (text) => text.includes('That looks right'))
  await manager.call('task_admit', {
    research_id: taskId,
    message_id: await lastResearcherMessage(manager, 'That looks right'),
    brief_revision: proposal.revision,
  })
  await researcherSays(request, api, projectId, channelId, 'Please start it now.')
  await waitForPrompt(generalConversation, (text) => text.includes('Please start it now'))
  await manager.call('task_start', { research_id: taskId, message_id: await lastResearcherMessage(manager, 'Please start it now') })
  await manager.call('task_request_review', {
    research_id: taskId,
    summary: 'Pruning heads kept accuracy at 0.91, within one point.',
    evidence: ['file:results.csv', `research:${evidence.id}`],
  })

  // The researcher's message about the Task, with a long conversation after it.
  const citingMessageId = await researcherSays(
    request, api, projectId, channelId, 'The pruning heads results are in; I will review them.', [{ kind: 'research', id: taskId }],
  )
  for (let index = 0; index < laterMessages; index += 1) {
    await manager.call('general_post', { body: `Later note ${index + 1} about the sweep schedule.`, mentions: [] })
  }
  return { taskId, taskTitle, evidenceId: evidence.id, evidenceTitle, citingMessageId, channelId }
}
