import { describe, expect, it } from 'vitest'

import {
  acpCommandCanDispatch,
  activeAcpCommand,
  availableAcpCommands,
  completeAcpCommand,
  matchingAcpCommands,
} from './acpCommands'

describe('ACP commands', () => {
  const commands = availableAcpCommands({ availableCommands: [
    { name: 'map', description: 'substring', input: null },
    { name: 'review', description: 'exact', input: { kind: 'text', hint: 'focus' } },
    { name: 'preview', description: 'substring later', input: null },
    { name: 'restore-view', description: 'subsequence', input: null },
  ] })

  it('preserves provider fields and marks duplicate names ambiguous', () => {
    const parsed = availableAcpCommands({ availableCommands: [
      { name: 'review', description: 'First', input: { kind: 'text', hint: 'focus' } },
      { name: 'review', description: 'Second', input: null },
      { name: 'future', description: 'Future', input: { kind: 'unsupported' } },
    ] })
    expect(parsed).toEqual([
      expect.objectContaining({ name: 'review', providerIndex: 0, ambiguous: true,
        input: { kind: 'text', hint: 'focus' } }),
      expect.objectContaining({ name: 'review', providerIndex: 1, ambiguous: true,
        input: { kind: 'none' } }),
      expect.objectContaining({ name: 'future', providerIndex: 2, ambiguous: false,
        input: { kind: 'unsupported' } }),
    ])
  })

  it('ranks exact, prefix, substring, then subsequence with provider order as tie-breaker', () => {
    expect(matchingAcpCommands(commands, 'review').map((command) => command.name)).toEqual([
      'review', 'preview', 'restore-view',
    ])
    expect(matchingAcpCommands(commands, 'rv').map((command) => command.name)).toEqual([
      'review', 'preview', 'restore-view',
    ])
  })

  it('distinguishes completion from ready dispatch', () => {
    const review = commands[1]
    const map = commands[0]
    expect(completeAcpCommand(review)).toBe('/review ')
    expect(acpCommandCanDispatch(review, activeAcpCommand('/review')!)).toBe(false)
    expect(acpCommandCanDispatch(review, activeAcpCommand('/review security')!)).toBe(true)
    expect(acpCommandCanDispatch(map, activeAcpCommand('/m')!)).toBe(true)
  })
})
