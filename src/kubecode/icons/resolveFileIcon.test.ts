import { describe, expect, it } from 'vitest'

import { resolveDirectoryIcon, resolveFileIcon } from './resolveFileIcon'

describe('resolveFileIcon', () => {
  it('matches exact filenames before extensions', () => {
    expect(resolveFileIcon('package.json')).toBe('npm')
    expect(resolveFileIcon('Cargo.toml')).toBe('toml')
    expect(resolveFileIcon('Makefile')).toBe('makefile')
  })

  it('matches exact filenames case-insensitively', () => {
    expect(resolveFileIcon('MAKEFILE')).toBe('makefile')
    expect(resolveFileIcon('Dockerfile')).toBe('docker')
    expect(resolveFileIcon('README')).toBe('readme')
  })

  it('prefers the longest compound suffix', () => {
    expect(resolveFileIcon('Button.test.tsx')).toBe('test-jsx')
    expect(resolveFileIcon('Button.spec.tsx')).toBe('test-jsx')
    expect(resolveFileIcon('vite.config.ts')).toBe('vite')
    expect(resolveFileIcon('types.d.ts')).toBe('typescript-def')
    expect(resolveFileIcon('a.config.test.ts')).toBe('test-ts')
  })

  it('falls back to plain extensions', () => {
    expect(resolveFileIcon('main.rs')).toBe('rust')
    expect(resolveFileIcon('App.tsx')).toBe('react_ts')
    expect(resolveFileIcon('index.ts')).toBe('typescript')
    expect(resolveFileIcon('shell.nix')).toBe('file')
  })

  it('uses semantic stems for documentation fallbacks', () => {
    expect(resolveFileIcon('HISTORY.md')).toBe('changelog')
    expect(resolveFileIcon('NOTICE')).toBe('license')
    expect(resolveFileIcon('CONTRIBUTING.md')).toBe('contributing')
  })

  it('resolves git and env dotfiles by exact name', () => {
    expect(resolveFileIcon('.gitignore')).toBe('git')
    expect(resolveFileIcon('.env.local')).toBe('tune')
  })

  it('resolves relative paths against their basename', () => {
    expect(resolveFileIcon('src/package.json')).toBe('npm')
    expect(resolveFileIcon('docs\\README.md')).toBe('readme') // backslash separator
    expect(resolveFileIcon('server/src/main.rs')).toBe('rust')
    expect(resolveFileIcon('a/b/c/')).toBe('file')
  })

  it('falls back to the generic file for unknown names', () => {
    expect(resolveFileIcon('unknown.zzz')).toBe('file')
    expect(resolveFileIcon('no-extension')).toBe('file')
    expect(resolveFileIcon('')).toBe('file')
    expect(resolveFileIcon('  ')).toBe('file')
  })
})

describe('resolveDirectoryIcon', () => {
  it('matches audited directory names case-insensitively', () => {
    expect(resolveDirectoryIcon('src')).toBe('folder-src')
    expect(resolveDirectoryIcon('__tests__')).toBe('folder-test')
    expect(resolveDirectoryIcon('Node_Modules')).toBe('folder-node')
  })

  it('uses the -open companion when expanded', () => {
    expect(resolveDirectoryIcon('src', true)).toBe('folder-src-open')
    expect(resolveDirectoryIcon('docs', true)).toBe('folder-docs-open')
  })

  it('stays closed when not expanded', () => {
    expect(resolveDirectoryIcon('docs')).toBe('folder-docs')
  })

  it('falls back to the generic folder baselines', () => {
    expect(resolveDirectoryIcon('arbitrary')).toBe('folder')
    expect(resolveDirectoryIcon('arbitrary', true)).toBe('folder-open')
    expect(resolveDirectoryIcon('')).toBe('folder')
    expect(resolveDirectoryIcon('', true)).toBe('folder-open')
  })
})
