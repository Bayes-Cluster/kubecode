import { describe, expect, it } from 'vitest'

import { fileIconKind } from './fileIconKinds'

describe('fileIconKind', () => {
  it.each([
    ['main.tsx', 'code'],
    ['lib.rs', 'code'],
    ['experiment.py', 'code'],
    ['config.yaml', 'config'],
    ['package.json', 'config'],
    ['README.md', 'document'],
    ['figure.svg', 'image'],
    ['LICENSE', 'file'],
  ] as const)('maps %s to %s', (name, kind) => {
    expect(fileIconKind(name)).toBe(kind)
  })
})
