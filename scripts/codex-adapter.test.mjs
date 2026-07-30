import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  advertiseCodexSkills,
  buildCodexPromptItems,
  codexSkillHistoryContent,
} from '../packaging/adapter-runtime/codex-skills.mjs'

test('loads the pinned Codex adapter with the Kubecode dependency patch', async () => {
  const adapterPackage = JSON.parse(await readFile(
    new URL('../packaging/adapter-runtime/package.json', import.meta.url),
    'utf8',
  ))
  const rootPackage = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ))
  assert.equal(adapterPackage.dependencies['@agentclientprotocol/codex-acp'], '1.1.2')
  assert.equal(
    rootPackage.pnpm.patchedDependencies['@agentclientprotocol/codex-acp@1.1.2'],
    'patches/@agentclientprotocol__codex-acp@1.1.2.patch',
  )

  const entry = fileURLToPath(new URL(
    '../packaging/adapter-runtime/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
    import.meta.url,
  ))
  const result = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '@agentclientprotocol/codex-acp 1.1.2')
})

const skills = [{
  cwd: '/srv/project',
  errors: [],
  skills: [
    {
      name: 'review',
      description: 'Review this project',
      shortDescription: 'Project review',
      path: '/srv/project/.agents/skills/review/SKILL.md',
      scope: 'repo',
      enabled: true,
    },
    {
      name: 'review',
      description: 'Review any project',
      path: '/home/user/.codex/skills/review/SKILL.md',
      scope: 'user',
      enabled: true,
    },
    {
      name: 'policy',
      description: 'Apply organization policy',
      path: '/etc/codex/skills/policy/SKILL.md',
      scope: 'admin',
      enabled: false,
    },
  ],
}]

test('advertises exact Codex skill identities without text fallback commands', () => {
  const update = advertiseCodexSkills({
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'status', description: 'Show status', input: null }],
    _meta: { existing: true },
  }, skills)

  assert.deepEqual(update.availableCommands.map(({ name }) => name), ['status'])
  assert.equal(update._meta.existing, true)
  assert.equal(update._meta.kubecode.codexSkills.version, 1)
  assert.equal(update._meta.kubecode.codexSkills.supported, true)
  assert.equal(update._meta.kubecode.codexSkills.structuredInput, true)
  assert.equal(update._meta.kubecode.codexSkills.textFallback, false)
  assert.deepEqual(update._meta.kubecode.codexSkills.skills, [
    {
      identity: '/srv/project/.agents/skills/review/SKILL.md',
      name: 'review',
      description: 'Project review',
      path: '/srv/project/.agents/skills/review/SKILL.md',
      providerScope: 'repo',
      sourceLabel: 'Project skill',
      enabled: true,
    },
    {
      identity: '/home/user/.codex/skills/review/SKILL.md',
      name: 'review',
      description: 'Review any project',
      path: '/home/user/.codex/skills/review/SKILL.md',
      providerScope: 'user',
      sourceLabel: 'User skill',
      enabled: true,
    },
    {
      identity: '/etc/codex/skills/policy/SKILL.md',
      name: 'policy',
      description: 'Apply organization policy',
      path: '/etc/codex/skills/policy/SKILL.md',
      providerScope: 'admin',
      sourceLabel: 'Admin skill',
      enabled: false,
      disabledReason: 'provider_disabled',
    },
  ])
})

test('builds one structured skill input without injecting its display token', () => {
  const request = {
    sessionId: 'session-1',
    prompt: [{ type: 'text', text: 'focus on tests' }],
    _meta: {
      kubecode: {
        providerStructuredInput: {
          adapterKind: 'codex',
          payload: {
            type: 'skill',
            name: 'review',
            path: '/srv/project/.agents/skills/review/SKILL.md',
          },
        },
      },
    },
  }
  const input = buildCodexPromptItems(request, (prompt) => prompt.map((block) => ({
    type: 'text',
    text: block.text,
    text_elements: [],
  })))

  assert.deepEqual(input, [
    {
      type: 'skill',
      name: 'review',
      path: '/srv/project/.agents/skills/review/SKILL.md',
    },
    { type: 'text', text: 'focus on tests', text_elements: [] },
  ])
  assert.equal(JSON.stringify(input).includes('$review'), false)
})

test('publishes an empty replacement when Codex skill discovery is unsupported', () => {
  const update = advertiseCodexSkills({
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'status', description: 'Show status', input: null }],
  }, skills, false)

  assert.deepEqual(update.availableCommands.map(({ name }) => name), ['status'])
  assert.deepEqual(update._meta.kubecode.codexSkills, {
    version: 1,
    supported: false,
    structuredInput: true,
    textFallback: false,
    skills: [],
  })
})

test('rejects malformed or non-Codex structured metadata', () => {
  const base = { prompt: [{ type: 'text', text: '$review' }] }
  const build = (prompt) => prompt
  assert.deepEqual(buildCodexPromptItems(base, build), base.prompt)
  assert.deepEqual(buildCodexPromptItems({
    ...base,
    _meta: {
      kubecode: {
        providerStructuredInput: {
          adapterKind: 'claude',
          payload: { type: 'skill', name: 'review', path: '/private/skill' },
        },
      },
    },
  }, build), base.prompt)
  assert.deepEqual(
    advertiseCodexSkills({ availableCommands: [] }, { skills: 'not-an-array' })
      ._meta.kubecode.codexSkills.skills,
    [],
  )
})

test('redacts provider paths when replaying Codex skill history', () => {
  assert.deepEqual(codexSkillHistoryContent({
    type: 'skill',
    name: 'review',
    path: '/srv/project/.agents/skills/review/SKILL.md',
  }), [{ type: 'text', text: 'skill:$review' }])
})
