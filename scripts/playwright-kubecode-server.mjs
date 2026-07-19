#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const port = process.argv[2] ?? '41741'
const root = await mkdtemp(join(tmpdir(), `kubecode-playwright-${port}-`))
const state = join(root, '.state', 'kubecode')
const fakeOpenCode = join(root, 'opencode')
const configuredServerBinary = process.env.KUBECODE_SERVER_BIN

await writeFile(fakeOpenCode, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "opencode smoke 1.0"
  exit 0
fi
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/"\\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\\n' "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"protocolVersion\\":1,\\"agentCapabilities\\":{},\\"authMethods\\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\\n' "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"sessionId\\":\\"playwright-session\\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"playwright-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Smoke Agent is ready"}}}}'
      printf '%s\\n' "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"stopReason\\":\\"end_turn\\"}}"
      ;;
  esac
done
`)
await chmod(fakeOpenCode, 0o755)

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
    KUBECODE_OPENCODE_PATH: fakeOpenCode,
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
