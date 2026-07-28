import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  advertiseSideQuestion,
  askClaudeSideQuestion,
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
