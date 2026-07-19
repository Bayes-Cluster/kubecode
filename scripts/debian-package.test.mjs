import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

test('Debian package metadata installs the standalone runtime without a service', () => {
  const config = readFileSync(join(repository, 'packaging', 'deb', 'nfpm.yaml'), 'utf8')

  assert.match(config, /dst: \/usr\/bin\/kubecode/)
  assert.match(config, /dst: \/usr\/lib\/kubecode/)
  assert.match(config, /libc6 \(>= 2\.28\)/)
  assert.match(config, /libstdc\+\+6/)
  assert.match(config, /- git/)
  assert.doesNotMatch(config, /systemd|\.service/)
})

test('Debian builder maps standalone architecture and version into nFPM', () => {
  const root = mkdtempSync(join(tmpdir(), 'kubecode deb package with spaces-'))
  const standalone = join(root, 'kubecode-0.1.0-linux-amd64')
  const output = join(root, 'packages')
  const fakeNfpm = join(root, 'bin', 'nfpm')
  const capture = join(root, 'nfpm-environment.txt')

  mkdirSync(standalone, { recursive: true })
  writeFileSync(join(standalone, 'VERSION'), '0.1.0\n')
  executable(join(standalone, 'bin', 'kubecode'), '#!/bin/sh\nexit 0\n')
  executable(join(standalone, 'lib', 'kubecode', 'kubecode-server'), '#!/bin/sh\nexit 0\n')
  executable(join(standalone, 'lib', 'kubecode', 'node'), '#!/bin/sh\nexit 0\n')
  executable(join(standalone, 'libexec', 'kubecode', 'claude-agent-acp'), '#!/bin/sh\nexit 0\n')
  executable(join(standalone, 'libexec', 'kubecode', 'codex-acp'), '#!/bin/sh\nexit 0\n')
  mkdirSync(join(standalone, 'lib', 'kubecode', 'dist'), { recursive: true })
  writeFileSync(join(standalone, 'lib', 'kubecode', 'dist', 'index.html'), '<div id="root"></div>')
  executable(
    fakeNfpm,
    `#!/bin/sh
set -eu
target=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--target" ]; then
    target=$2
    shift 2
  else
    shift
  fi
done
test -n "$target"
mkdir -p "$(dirname "$target")"
printf 'fake deb\\n' > "$target"
printf '%s\\n%s\\n%s\\n' "$KUBECODE_VERSION" "$KUBECODE_DEB_ARCH" "$KUBECODE_STANDALONE_DIR" > "$KUBECODE_FAKE_CAPTURE"
`,
  )

  const result = spawnSync(
    join(repository, 'scripts', 'build-deb.sh'),
    [
      '--version',
      '0.1.0',
      '--arch',
      'amd64',
      '--standalone-dir',
      standalone,
      '--output-dir',
      output,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        KUBECODE_FAKE_CAPTURE: capture,
        NFPM_BIN: fakeNfpm,
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(output, 'kubecode_0.1.0_amd64.deb')), true)
  assert.deepEqual(readFileSync(capture, 'utf8').trim().split('\n'), [
    '0.1.0',
    'amd64',
    standalone,
  ])
})

test('release workflow publishes Debian packages without requiring a Git checkout', () => {
  const workflow = readFileSync(join(repository, '.github', 'workflows', 'release.yml'), 'utf8')

  assert.match(workflow, /release\/\*\.deb/)
  assert.match(workflow, /kubecode_"\$version"_\*\.deb/)
  assert.match(workflow, /--repo "\$GITHUB_REPOSITORY"/)
})
