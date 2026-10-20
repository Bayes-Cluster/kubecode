import type { Translator } from '@/lib/i18n'

import type { Conversation, RunStatus } from './api'

/** What a Project's Sessions are doing, in one word for its navigation row. */
export type ProjectRunState = RunStatus | 'stuck'

/** A Session's run state in words, so the state never rests on colour alone. */
export function runStatusLabel(status: RunStatus, t: Translator): string {
  if (status === 'running') return t('kubecode.running')
  if (status === 'waiting_permission') return t('kubecode.permissionRequired')
  if (status === 'completed') return t('kubecode.ready')
  return t('kubecode.error')
}

/** A Project's run state in words; nothing when it is idle. */
export function projectStatusLabel(status: ProjectRunState | null, t: Translator): string | undefined {
  if (status === 'stuck') return t('kubecode.permissionRequired')
  return status ? runStatusLabel(status, t) : undefined
}

/** A Project's run state from its Sessions' latest runs, until its runs are read. */
export function sessionsRunState(conversations: readonly Conversation[]): RunStatus | null {
  const statuses = conversations.map((conversation) => conversation.latest_run_status)
  if (statuses.includes('waiting_permission')) return 'waiting_permission'
  if (statuses.some((status) => (
    status === 'failed' || status === 'timed_out' || status === 'interrupted'
  ))) return 'failed'
  return statuses.includes('running') ? 'running' : null
}
