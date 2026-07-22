#!/usr/bin/env node
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

import { agent as acpAgent, methods, ndJsonStream } from '@agentclientprotocol/sdk'
import {
  ClaudeAcpAgent,
  nodeToWebReadable,
  nodeToWebWritable,
} from '@agentclientprotocol/claude-agent-acp'
import { claudeCliPath } from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk'

const require = createRequire(import.meta.url)
const packageJson = require('@agentclientprotocol/claude-agent-acp/package.json')
const SIDE_QUESTION_METHOD = '_claude/side_question'

function acpClient(context) {
  return {
    sessionUpdate: (params) => context.notify(methods.client.session.update, params),
    requestPermission: (params, signal) => context.request(
      methods.client.session.requestPermission,
      params,
      { cancellationSignal: signal },
    ),
    readTextFile: (params) => context.request(methods.client.fs.readTextFile, params),
    writeTextFile: (params) => context.request(methods.client.fs.writeTextFile, params),
    unstable_createElicitation: (params, signal) => context.request(
      methods.client.elicitation.create,
      params,
      { cancellationSignal: signal },
    ),
    unstable_completeElicitation: (params) => context.notify(
      methods.client.elicitation.complete,
      params,
    ),
    extNotification: (method, params) => context.notify(method, params),
  }
}

function parseSideQuestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('side-question params must be an object')
  }
  const { sessionId, question } = value
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('sessionId must be a non-empty string')
  }
  if (typeof question !== 'string' || !question.trim()) {
    throw new TypeError('question must be a non-empty string')
  }
  return { sessionId, question: question.trim() }
}

export function advertiseSideQuestion(response) {
  const capabilities = response.agentCapabilities
  const meta = capabilities._meta ?? {}
  const claudeCode = meta.claudeCode && typeof meta.claudeCode === 'object'
    ? meta.claudeCode
    : {}
  capabilities._meta = {
    ...meta,
    claudeCode: { ...claudeCode, sideQuestion: true },
  }
  return response
}

export async function askClaudeSideQuestion(agent, params) {
  const session = agent.sessions[params.sessionId]
  const askSideQuestion = session?.query?.askSideQuestion
  if (typeof askSideQuestion !== 'function') {
    throw new Error('Claude Agent SDK side questions are unavailable for this session')
  }
  const result = await askSideQuestion.call(session.query, params.question)
  return {
    response: typeof result?.response === 'string' ? result.response : '',
    synthetic: result?.synthetic ?? null,
  }
}

async function promptWithCancellation(agent, params, signal) {
  const onAbort = () => {
    agent.cancel({ sessionId: params.sessionId }).catch((error) => {
      agent.logger.error(`Failed to cancel prompt via $/cancel_request: ${error}`)
    })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await agent.prompt(params)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function runKubecodeClaudeAcp() {
  const stream = ndJsonStream(
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin),
  )
  let agent
  const connection = acpAgent({ name: 'kubecode-claude-code-acp' })
    .onRequest(methods.agent.initialize, async (context) => {
      return advertiseSideQuestion(await agent.initialize(context.params))
    })
    .onRequest(methods.agent.session.new, (context) => agent.newSession(context.params))
    .onRequest(methods.agent.session.load, (context) => agent.loadSession(context.params))
    .onRequest(methods.agent.session.fork, (context) => agent.unstable_forkSession(context.params))
    .onRequest(methods.agent.session.list, (context) => agent.listSessions(context.params))
    .onRequest(methods.agent.session.delete, (context) => agent.deleteSession(context.params))
    .onRequest(methods.agent.session.resume, (context) => agent.resumeSession(context.params))
    .onRequest(methods.agent.session.close, (context) => agent.closeSession(context.params))
    .onRequest(methods.agent.session.setMode, (context) => agent.setSessionMode(context.params))
    .onRequest(methods.agent.session.setConfigOption, (context) => agent.setSessionConfigOption(context.params))
    .onRequest(methods.agent.authenticate, (context) => agent.authenticate(context.params))
    .onRequest(methods.agent.logout, (context) => agent.logout(context.params))
    .onRequest(methods.agent.session.prompt, (context) => (
      promptWithCancellation(agent, context.params, context.signal)
    ))
    .onRequest(SIDE_QUESTION_METHOD, parseSideQuestion, async (context) => {
      return askClaudeSideQuestion(agent, context.params)
    })
    .onNotification(methods.agent.session.cancel, (context) => agent.cancel(context.params))
    .connect(stream)
  agent = new ClaudeAcpAgent(acpClient(connection.client))
  return { connection, agent }
}

async function runCli() {
  const args = process.argv.slice(2).filter((argument) => argument !== '--cli')
  const child = spawn(await claudeCliPath(), args, { stdio: 'inherit' })
  const signals = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM']
    : ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  }
  child.on('exit', (code, signal) => {
    if (signal && process.platform !== 'win32') {
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 1)
    }
  })
  child.on('error', (error) => {
    console.error(error)
    process.exit(1)
  })
}

async function main() {
  if (process.argv.includes('--cli')) {
    await runCli()
    return
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(packageJson.version)
    return
  }

  const policy = await resolveSettings({ settingSources: [] })
  for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
    process.env[key] = value
  }
  console.log = console.error
  console.info = console.error
  console.warn = console.error
  console.debug = console.error
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })
  const { connection, agent } = runKubecodeClaudeAcp()
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await agent.dispose().catch((error) => console.error('Error during cleanup:', error))
    process.exit(0)
  }
  connection.closed.then(shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stdin.resume()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
