import { fuzzyMatchRank } from './fuzzyMatch'

export type AcpCommandInput =
  | { kind: 'none' }
  | { kind: 'text'; hint?: string }
  | { kind: 'unsupported' }

export type AcpCommand = {
  name: string
  description: string
  input: AcpCommandInput
  providerIndex: number
  ambiguous: boolean
  privateSideQuestion?: boolean
}

export type ActiveAcpCommand = {
  name: string
  arguments: string
}

export function availableAcpCommands(
  availableCommands: Record<string, unknown> | null | undefined,
): AcpCommand[] {
  const values = availableCommands?.availableCommands
  if (!Array.isArray(values)) return []
  const commands = values.flatMap((value, providerIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    if (typeof row.name !== 'string' || !row.name) return []
    if (typeof row.description !== 'string') return []
    const input = commandInput(row.input)
    return [{
      name: row.name,
      description: row.description,
      input,
      providerIndex,
      ambiguous: false,
    } satisfies AcpCommand]
  })
  const counts = new Map<string, number>()
  for (const command of commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1)
  return commands.map((command) => ({
    ...command,
    ambiguous: (counts.get(command.name) ?? 0) > 1,
  }))
}

function commandInput(value: unknown): AcpCommandInput {
  if (value === null || value === undefined) return { kind: 'none' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unsupported' }
  const input = value as Record<string, unknown>
  if (input.kind === 'text'
    && (input.hint === undefined || typeof input.hint === 'string')) {
    return input.hint === undefined
      ? { kind: 'text' }
      : { kind: 'text', hint: input.hint }
  }
  return { kind: 'unsupported' }
}

export function activeAcpCommand(prompt: string): ActiveAcpCommand | null {
  const match = prompt.match(/^\/([^\s/]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { name: match[1], arguments: match[2]?.trim() ?? '' }
}

export function matchingAcpCommands(commands: AcpCommand[], query: string): AcpCommand[] {
  const normalized = query.toLocaleLowerCase()
  return commands
    .flatMap((command) => {
      const score = fuzzyMatchRank(normalized, {
        primary: [command.name.toLocaleLowerCase()],
      }, ACP_COMMAND_MATCH_WEIGHTS)
      return score === null ? [] : [{ command, score }]
    })
    .sort((left, right) => left.score - right.score
      || left.command.providerIndex - right.command.providerIndex)
    .map(({ command }) => command)
}

const ACP_COMMAND_MATCH_WEIGHTS = {
  empty: 1,
  exact: 0,
  prefix: 1,
  subsequence: 3,
  substring: 2,
} as const

export function completeAcpCommand(command: AcpCommand): string {
  return `/${command.name}${command.input.kind === 'text' ? ' ' : ''}`
}

export function acpCommandCanDispatch(
  command: AcpCommand,
  active: ActiveAcpCommand,
): boolean {
  if (command.ambiguous || command.input.kind === 'unsupported') return false
  if (command.input.kind === 'none') return active.arguments.length === 0
  return command.name === active.name && active.arguments.length > 0
}
