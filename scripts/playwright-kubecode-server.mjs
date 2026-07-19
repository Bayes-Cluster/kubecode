#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const port = process.argv[2] ?? '41741'
const root = await mkdtemp(join(tmpdir(), `kubecode-playwright-${port}-`))
const state = join(root, '.state', 'kubecode')
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

if (!existsSync('dist/index.html')) {
  await run('pnpm', ['build'])
}

if (configuredServerBinary && !existsSync(configuredServerBinary)) {
  throw new Error(`KUBECODE_SERVER_BIN does not exist: ${configuredServerBinary}`)
}

const serverCommand = configuredServerBinary ?? 'cargo'
const serverArguments = configuredServerBinary
  ? []
  : ['run', '--locked', '--manifest-path', 'server/Cargo.toml']
const server = spawn(serverCommand, serverArguments, {
  env: {
    ...process.env,
    KUBECODE_BASE_PATH: '/user/local/kubecode',
    KUBECODE_HOST: '127.0.0.1',
    KUBECODE_PORT: port,
    KUBECODE_STATE_DIR: state,
    KUBECODE_STATIC_DIR: 'dist',
    KUBECODE_WORKSPACE_ROOT: root,
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
