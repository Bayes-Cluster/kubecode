import type { TranslationKey } from '@/lib/i18n'

import type { ProjectContextItem, ProjectContextKind } from './api'

/** Every reference kind the server's Project context reader understands (ADR 0214). */
export const PROJECT_CONTEXT_KINDS: string[] = [
  'research', 'round', 'finding', 'session', 'session_turn', 'team', 'team_task',
  'experiment', 'artifact',
]

/** Translation keys for each kind's label, so the copy lives in the locale catalogs. */
export const PROJECT_CONTEXT_KIND_LABELS: Record<ProjectContextKind, TranslationKey> = {
  research: 'kubecode.projectWorkKindResearch',
  round: 'kubecode.projectWorkKindRound',
  finding: 'kubecode.projectWorkKindFinding',
  session: 'kubecode.projectWorkKindSession',
  session_turn: 'kubecode.projectWorkKindSessionTurn',
  team: 'kubecode.projectWorkKindTeam',
  team_task: 'kubecode.projectWorkKindTeamTask',
  experiment: 'kubecode.projectWorkKindExperiment',
  artifact: 'kubecode.projectWorkKindArtifact',
}

/** The picker's filter groups. `null` kinds means every kind. */
export type ProjectWorkFilter = 'all' | 'research' | 'findings' | 'sessions' | 'teams' | 'experiments'
export const PROJECT_WORK_FILTERS: Array<{
  id: ProjectWorkFilter
  kinds: ProjectContextKind[] | null
  label: TranslationKey
}> = [
  { id: 'all', kinds: null, label: 'kubecode.projectWorkFilterAll' },
  { id: 'research', kinds: ['research', 'round'], label: 'kubecode.projectWorkFilterResearch' },
  { id: 'findings', kinds: ['finding'], label: 'kubecode.projectWorkFilterFindings' },
  { id: 'sessions', kinds: ['session'], label: 'kubecode.projectWorkFilterSessions' },
  { id: 'teams', kinds: ['team', 'team_task'], label: 'kubecode.projectWorkFilterTeams' },
  {
    id: 'experiments',
    kinds: ['experiment', 'artifact'],
    label: 'kubecode.projectWorkFilterExperiments',
  },
]

/** `kind:id`, the server's selector for a reference. The id is opaque. */
export function projectContextSelector(ref: Pick<ProjectContextItem['ref'], 'kind' | 'id'>): string {
  return `${ref.kind}:${ref.id}`
}

/**
 * The current Session's own turns keep their dedicated contract, so the
 * picker does not offer them through this kind.
 */
export function isOwnSessionReference(
  ref: Pick<ProjectContextItem['ref'], 'kind' | 'id'>,
  conversationId: string,
): boolean {
  if (ref.kind === 'session') return ref.id === conversationId
  if (ref.kind === 'session_turn') return ref.id.split('/')[0] === conversationId
  return false
}
