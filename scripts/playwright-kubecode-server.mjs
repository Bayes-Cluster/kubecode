#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = process.argv[2] ?? '41741'
const localState = join(process.cwd(), '.local')
await mkdir(localState, { recursive: true })
const root = await mkdtemp(join(localState, `kubecode-playwright-${port}-`))
const state = join(root, '.state', 'kubecode')
const fixtureDir = join(localState, `playwright-fixtures-${port}`)
await rm(fixtureDir, { force: true, recursive: true })
const fakeOpenCode = join(process.cwd(), 'scripts/fixtures/playwright-opencode')
const configuredServerBinary = process.env.KUBECODE_SERVER_BIN

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} exited via ${signal}`))
      else if (code === 0) resolve()
      else reject(new Error(`${command} exited with status ${code}`))
    })
  })
}

await run('pnpm', ['build'])

if (configuredServerBinary && !existsSync(configuredServerBinary)) {
  throw new Error(`KUBECODE_SERVER_BIN does not exist: ${configuredServerBinary}`)
}

const serverCommand = configuredServerBinary ?? 'cargo'
const serverArguments = configuredServerBinary
  ? []
  : ['run', '--locked', '--manifest-path', 'server/Cargo.toml']
// A git hook (pre-push) exports GIT_DIR and friends. The server and the
// projects the smoke tests create must not see them, or every directory would
// look like a clone of the repository that is being pushed.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
)
const server = spawn(serverCommand, serverArguments, {
  env: {
    ...environment,
    KUBECODE_BASE_PATH: '/user/local/kubecode',
    KUBECODE_HOST: '127.0.0.1',
    KUBECODE_PORT: port,
    KUBECODE_STATE_DIR: state,
    KUBECODE_STATIC_DIR: 'dist',
    KUBECODE_WORKSPACE_ROOT: root,
    KUBECODE_OPENCODE_PATH: fakeOpenCode,
    KUBECODE_PLAYWRIGHT_FIXTURE_DIR: fixtureDir,
  },
  stdio: 'inherit',
})

let stopping = false
async function stop(signal) {
  if (stopping) return
  stopping = true
  server.kill(signal)
  await rm(root, { force: true, recursive: true })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void stop(signal)
  })
}

server.once('error', async (error) => {
  await stop('SIGTERM')
  throw error
})
server.once('exit', async (code, signal) => {
  await rm(root, { force: true, recursive: true })
  if (!stopping && (signal || code !== 0)) {
    process.exitCode = code ?? 1
  }
})
