import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  markdownAnchors,
  validateLocalMarkdownTarget,
} from './docs-links.mjs'

test('generates GitHub-style anchors for Unicode, formatting, and duplicate headings', () => {
  const anchors = markdownAnchors(`
# Agent Discovery
## Agent 发现
## Repeated heading
## Repeated heading
## \`Inline code\` and [link text](https://example.com)
## API_name v2.0!
<a id="manual-anchor"></a>
`)

  assert.deepEqual([...anchors], [
    'agent-discovery',
    'agent-发现',
    'repeated-heading',
    'repeated-heading-1',
    'inline-code-and-link-text',
    'api_name-v20',
    'manual-anchor',
  ])
})

test('validates same-file, cross-file, encoded, duplicate, and explicit anchors', () => {
  withFixture((root, sourcePath) => {
    assert.equal(validateLocalMarkdownTarget(root, sourcePath, '#overview'), null)
    assert.equal(
      validateLocalMarkdownTarget(
        root,
        sourcePath,
        'guides/install.md#agent-%E5%8F%91%E7%8E%B0',
      ),
      null,
    )
    assert.equal(
      validateLocalMarkdownTarget(root, sourcePath, 'guides/install.md#repeated-1'),
      null,
    )
    assert.equal(
      validateLocalMarkdownTarget(root, sourcePath, 'guides/install.md#manual'),
      null,
    )
  })
})

test('reports missing anchors and invalid URL encoding while ignoring remote links', () => {
  withFixture((root, sourcePath) => {
    assert.match(
      validateLocalMarkdownTarget(root, sourcePath, 'guides/install.md#missing'),
      /missing anchor #missing/,
    )
    assert.match(
      validateLocalMarkdownTarget(root, sourcePath, 'guides/install.md#bad%ZZ'),
      /invalid URL encoding/,
    )
    assert.equal(
      validateLocalMarkdownTarget(root, sourcePath, 'https://example.com/docs#missing'),
      null,
    )
    assert.match(
      validateLocalMarkdownTarget(root, sourcePath, 'guides/missing.md'),
      /missing local target/,
    )
    assert.match(
      validateLocalMarkdownTarget(root, sourcePath, '../outside.md'),
      /outside the repository/,
    )
  })
})

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'kubecode-docs-links-'))
  try {
    mkdirSync(join(root, 'guides'))
    const sourcePath = join(root, 'README.md')
    writeFileSync(sourcePath, '# Overview\n')
    writeFileSync(
      join(root, 'guides/install.md'),
      [
        '# Install',
        '## Agent 发现',
        '## Repeated',
        '## Repeated',
        '<a id="manual"></a>',
      ].join('\n'),
    )
    run(root, sourcePath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
