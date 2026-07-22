import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  advertiseSideQuestion,
  askClaudeSideQuestion,
} from '../packaging/adapter-runtime/claude-agent-acp.mjs'

test('backports non-blocking Claude session creation to the pinned adapter', async () => {
  const adapterPackage = JSON.parse(await readFile(
    new URL('../packaging/adapter-runtime/package.json', import.meta.url),
    'utf8',
  ))
  const rootPackage = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ))
  const patch = await readFile(
    new URL('../patches/@agentclientprotocol__claude-agent-acp@0.59.0.patch', import.meta.url),
    'utf8',
  )

  assert.equal(adapterPackage.dependencies['@agentclientprotocol/claude-agent-acp'], '0.59.0')
  assert.equal(adapterPackage.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.207')
  assert.equal(
    rootPackage.pnpm.patchedDependencies['@agentclientprotocol/claude-agent-acp@0.59.0'],
    'patches/@agentclientprotocol__claude-agent-acp@0.59.0.patch',
  )
  assert.match(patch, /const contextWindowSize = inferContextWindowFromModel/)
  assert.doesNotMatch(patch, /^\+.*fetchContextWindowSize\(q/m)
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
