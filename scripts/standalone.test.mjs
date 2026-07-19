import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const repository = resolve(import.meta.dirname, '..')

function executable(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

test('standalone launcher resolves an installed symlink without host Node', () => {
  const root = mkdtempSync(join(tmpdir(), 'kubecode package with spaces-'))
  const packageRoot = join(root, 'lib', 'kubecode-0.1.0')
  const launcher = join(packageRoot, 'bin', 'kubecode')
  const server = join(packageRoot, 'lib', 'kubecode', 'kubecode-server')
  const command = join(root, 'bin', 'kubecode')

  mkdirSync(dirname(launcher), { recursive: true })
  cpSync(join(repository, 'packaging', 'bin', 'kubecode'), launcher)
  chmodSync(launcher, 0o755)
  executable(
    server,
    `#!/bin/sh
printf '%s\\n' "$KUBECODE_STATIC_DIR"
printf '%s\\n' "$KUBECODE_CLAUDE_ACP_PATH"
printf '%s\\n' "$KUBECODE_CODEX_ACP_PATH"
printf '%s\\n' "$*"
`,
  )
  mkdirSync(dirname(command), { recursive: true })
  symlinkSync(launcher, command)

  const result = spawnSync(command, ['--port', '9000'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    join(packageRoot, 'lib', 'kubecode', 'dist'),
    join(packageRoot, 'libexec', 'kubecode', 'claude-agent-acp'),
    join(packageRoot, 'libexec', 'kubecode', 'codex-acp'),
    '--port 9000',
  ])
})

test('installer verifies and installs a standalone archive without sudo', () => {
  const root = mkdtempSync(join(tmpdir(), 'kubecode-installer-'))
  const releases = join(root, 'releases')
  const release = join(releases, 'v0.1.0')
  const packageName = 'kubecode-0.1.0-linux-amd64'
  const packageRoot = join(root, packageName)
  const archiveName = `${packageName}.tar.gz`
  const archive = join(release, archiveName)
  const prefix = join(root, 'prefix')

  executable(join(packageRoot, 'bin', 'kubecode'), '#!/bin/sh\nexit 0\n')
  mkdirSync(release, { recursive: true })
  execFileSync('tar', ['-czf', archive, '-C', root, packageName])
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(join(release, 'kubecode-0.1.0-SHA256SUMS'), `${hash}  ${archiveName}\n`)

  const result = spawnSync(
    join(repository, 'install.sh'),
    ['--version', '0.1.0', '--prefix', prefix],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        KUBECODE_INSTALL_ARCH: 'x86_64',
        KUBECODE_INSTALL_OS: 'Linux',
        KUBECODE_RELEASE_BASE_URL: `file://${releases}`,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  const command = join(prefix, 'bin', 'kubecode')
  assert.equal(existsSync(join(prefix, 'lib', 'kubecode-0.1.0', 'bin', 'kubecode')), true)
  assert.equal(readlinkSync(command), join(prefix, 'lib', 'kubecode-0.1.0', 'bin', 'kubecode'))
})

test('installer dry-run performs no filesystem changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'kubecode-dry-run-'))
  const prefix = join(root, 'prefix')
  const result = spawnSync(
    join(repository, 'install.sh'),
    ['--version', '0.1.0', '--prefix', prefix, '--dry-run'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        KUBECODE_INSTALL_ARCH: 'aarch64',
        KUBECODE_INSTALL_OS: 'Linux',
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /kubecode-0\.1\.0-linux-arm64\.tar\.gz/)
  assert.equal(existsSync(prefix), false)
})
