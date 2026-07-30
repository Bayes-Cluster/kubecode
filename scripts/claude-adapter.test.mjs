import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  advertiseClaudeSkills,
  advertiseSideQuestion,
  askClaudeSideQuestion,
  createClaudeSkillSessionUpdateForwarder,
  refreshClaudeSkills,
} from '../packaging/adapter-runtime/claude-agent-acp.mjs'

test('pins the current Claude adapter with upstream non-blocking session creation', async () => {
  const adapterPackage = JSON.parse(await readFile(
    new URL('../packaging/adapter-runtime/package.json', import.meta.url),
    'utf8',
  ))
  const adapterVersion = adapterPackage.dependencies['@agentclientprotocol/claude-agent-acp']
  assert.equal(adapterVersion, '0.61.0')
  assert.equal(adapterPackage.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.217')

  const standaloneSmoke = await readFile(
    new URL('./smoke-standalone.sh', import.meta.url),
    'utf8',
  )
  const smokeVersion = standaloneSmoke.match(
    /claude-agent-acp" --version \| grep -Fx "([^"]+)"/,
  )?.[1]
  assert.equal(smokeVersion, adapterVersion)
})

test('advertises and dispatches the native Claude side-question extension', async () => {
  const response = advertiseSideQuestion({
    agentCapabilities: { _meta: { existing: true } },
  })
  assert.deepEqual(response.agentCapabilities._meta, {
    existing: true,
    claudeCode: { sideQuestion: true },
  })

  const calls = []
  const query = {
    async askSideQuestion(question) {
      calls.push(question)
      return { response: 'Still running tests.', synthetic: false }
    },
  }
  const answer = await askClaudeSideQuestion({
    sessions: { 'session-1': { query } },
  }, {
    sessionId: 'session-1',
    question: 'What are you doing?',
  })

  assert.deepEqual(calls, ['What are you doing?'])
  assert.deepEqual(answer, { response: 'Still running tests.', synthetic: false })
})

test('advertises safe Claude skill metadata without changing ACP commands', () => {
  const update = {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{
      name: 'review',
      description: 'Review code',
      input: { hint: '<path>' },
    }],
    _meta: { existing: true },
  }

  assert.deepEqual(advertiseClaudeSkills(update, [{
    name: 'review',
    description: 'Review code',
    argumentHint: '<path>',
    source: 'project',
    path: '/private/project/.claude/skills/review/SKILL.md',
  }]), {
    ...update,
    _meta: {
      existing: true,
      kubecode: {
        claudeSkills: {
          version: 1,
          supported: true,
          skills: [{
            identity: 'review',
            name: 'review',
            description: 'Review code',
            inputHint: '<path>',
            scope: 'project',
            sourceLabel: 'Project skill',
            enabled: true,
          }],
        },
      },
    },
  })

  const overlongIdentity = advertiseClaudeSkills(update, [{
    name: 'x'.repeat(513),
    path: '/private/skill.md',
  }])
  assert.deepEqual(overlongIdentity._meta.kubecode.claudeSkills.skills, [])
})

test('refreshes skills from the exact Claude Session and fails closed when unsupported', async () => {
  const calls = []
  const availableCommands = [{ name: 'review', description: 'Review code' }]
  const agent = {
    sessions: {
      'session-worktree': {
        cwd: '/srv/project/.kubecode/worktrees/session-worktree',
        query: {
          async reloadSkills() {
            calls.push('session-worktree')
            return { skills: [{ name: 'review', description: 'Review code', argumentHint: '' }] }
          },
        },
      },
      unsupported: { cwd: '/srv/project', query: {} },
    },
  }

  const refreshed = await refreshClaudeSkills(agent, 'session-worktree', availableCommands)
  assert.deepEqual(calls, ['session-worktree'])
  assert.deepEqual(refreshed.availableCommands, availableCommands)
  assert.equal(
    refreshed._meta.kubecode.claudeSkills.skills[0].identity,
    'review',
  )
  await refreshClaudeSkills(agent, 'session-worktree', availableCommands)
  assert.deepEqual(calls, ['session-worktree', 'session-worktree'])

  const unsupported = await refreshClaudeSkills(agent, 'unsupported', availableCommands)
  assert.deepEqual(unsupported._meta.kubecode.claudeSkills, {
    version: 1,
    supported: false,
    skills: [],
  })
})

test('refreshes skill metadata after command updates and reconnects without blocking them', async () => {
  const notifications = []
  const scheduled = []
  const inventories = [
    [{ name: 'review', description: 'Review code', argumentHint: '<path>' }],
    [{ name: 'deploy', description: 'Deploy code', argumentHint: '<environment>' }],
  ]
  const agent = {
    sessions: {
      session: {
        cwd: '/srv/project/.kubecode/worktrees/session',
        query: {
          async reloadSkills() {
            return { skills: inventories.shift() }
          },
        },
      },
    },
  }
  const forward = createClaudeSkillSessionUpdateForwarder(
    async (params) => notifications.push(params),
    () => agent,
    (callback) => scheduled.push(callback),
  )
  const update = (name) => ({
    sessionId: 'session',
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name, description: `${name} command`, input: { hint: '<arg>' } }],
    },
  })

  await forward(update('review'))
  assert.equal(notifications.length, 1, 'the authoritative ACP update is not delayed')
  assert.equal(scheduled.length, 1)
  scheduled.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    notifications[1].update._meta.kubecode.claudeSkills.skills[0].identity,
    'review',
  )

  await forward(update('deploy'))
  scheduled.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    notifications[3].update._meta.kubecode.claudeSkills.skills[0].identity,
    'deploy',
  )
})
