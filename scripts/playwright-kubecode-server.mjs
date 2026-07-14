#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const port = process.argv[2] ?? '41741'
const root = await mkdtemp(join(tmpdir(), `kubecode-playwright-${port}-`))
const state = join(root, '.state', 'kubecode')

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

const server = spawn('cargo', ['run', '--manifest-path', 'server/Cargo.toml'], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    KUBECODE_STATE_DIR: state,
    KUBECODE_STATIC_DIR: 'dist',
    NB_PREFIX: '/user/local/kubecode',
    PERSISTENT_DIR: root,
    PORT: port,
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
