import type { ExecutionEnvelopeLimits } from '../api'

/** Form state for an execution envelope; numbers stay strings while editing. */
export type EnvelopeDraft = {
  maxLaunches: string
  maxConcurrent: string
  maxRuntimeMinutes: string
  /** Hours from now; empty means no deadline. */
  deadlineHours: string
  maxNoProgress: string
  /** One command per line. */
  commands: string
  /** The deadline the envelope already has, kept unless the field is edited. */
  existingDeadline: number | null
  deadlineEdited: boolean
  /**
   * The commands as they were when editing began, and their text. Unedited
   * text keeps the exact original tokens, so quoting can never alter them.
   */
  existingCommands: string[][] | null
  existingCommandsText: string
}

export function defaultEnvelopeDraft(): EnvelopeDraft {
  return {
    maxLaunches: '5',
    maxConcurrent: '1',
    maxRuntimeMinutes: '30',
    deadlineHours: '',
    maxNoProgress: '3',
    commands: '',
    existingDeadline: null,
    deadlineEdited: false,
    existingCommands: null,
    existingCommandsText: '',
  }
}

export function draftFromLimits(limits: ExecutionEnvelopeLimits, now: number): EnvelopeDraft {
  const commandsText = limits.allowed_commands.map(joinCommand).join('\n')
  const remaining = limits.deadline_at === null ? null : Math.max(0, limits.deadline_at - now)
  return {
    maxLaunches: String(limits.max_launches),
    maxConcurrent: String(limits.max_concurrent),
    maxRuntimeMinutes: String(Math.max(1, Math.ceil(limits.max_runtime_secs / 60))),
    deadlineHours: remaining === null ? '' : String(Math.round((remaining / 3600) * 100) / 100),
    maxNoProgress: String(limits.max_no_progress),
    commands: commandsText,
    existingDeadline: limits.deadline_at,
    deadlineEdited: false,
    existingCommands: limits.allowed_commands,
    existingCommandsText: commandsText,
  }
}

/** Splits a command line into tokens, honoring simple single or double quotes. */
export function parseCommand(line: string): string[] {
  const tokens: string[] = []
  for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens
}

/** Quotes a token with whichever quote it does not contain (best effort). */
function joinCommand(tokens: string[]): string {
  return tokens
    .map((token) => {
      if (!/[\s"']|^$/.test(token)) return token
      return token.includes('"') ? `'${token}'` : `"${token}"`
    })
    .join(' ')
}

export type EnvelopeResult =
  | { ok: true; limits: ExecutionEnvelopeLimits }
  | { ok: false; field: 'launches' | 'concurrent' | 'runtime' | 'deadline' | 'noProgress' | 'commands' }

function whole(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const number = Number(value)
  return number >= min && number <= max ? number : null
}

/** Mirrors the server's bounds so mistakes show before a request is sent. */
export function limitsFromDraft(draft: EnvelopeDraft, now: number): EnvelopeResult {
  const maxLaunches = whole(draft.maxLaunches, 1, 50)
  if (maxLaunches === null) return { ok: false, field: 'launches' }
  const maxConcurrent = whole(draft.maxConcurrent, 1, 4)
  if (maxConcurrent === null) return { ok: false, field: 'concurrent' }
  const minutes = whole(draft.maxRuntimeMinutes, 1, 1440)
  if (minutes === null) return { ok: false, field: 'runtime' }
  const maxNoProgress = whole(draft.maxNoProgress, 1, 10)
  if (maxNoProgress === null) return { ok: false, field: 'noProgress' }
  let deadline: number | null = draft.existingDeadline
  if (draft.deadlineEdited || draft.existingDeadline === null) {
    if (draft.deadlineHours.trim() === '') {
      deadline = null
    } else {
      const hours = Number(draft.deadlineHours)
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) return { ok: false, field: 'deadline' }
      deadline = now + Math.round(hours * 3600)
    }
  }
  const commands = draft.existingCommands && draft.commands === draft.existingCommandsText
    ? draft.existingCommands
    : draft.commands
      .split('\n')
      .map((line) => parseCommand(line.trim()))
      .filter((tokens) => tokens.length > 0)
  if (
    commands.length === 0
    || commands.length > 20
    || commands.some((tokens) => (
      tokens.length > 32
      || tokens[0].trim() === ''
      || tokens.some((token) => token.length > 512)
    ))
  ) {
    return { ok: false, field: 'commands' }
  }
  return {
    ok: true,
    limits: {
      max_launches: maxLaunches,
      max_concurrent: maxConcurrent,
      deadline_at: deadline,
      max_runtime_secs: minutes * 60,
      max_no_progress: maxNoProgress,
      allowed_commands: commands,
    },
  }
}

/** The browser's clock in unix seconds, for a relative deadline at round start. */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}
