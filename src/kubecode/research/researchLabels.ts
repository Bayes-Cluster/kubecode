import type { Translator } from '@/lib/i18n'

import type {
  ResearchEntry,
  ResearchFindingKind,
  ResearchRoundPhase,
  ResearchSourceAvailability,
  ResearchSourceKind,
} from '../api'

export function availabilityLabel(t: Translator, availability: ResearchSourceAvailability): string {
  if (availability === 'changed') return t('kubecode.research.availability.changed')
  if (availability === 'removed') return t('kubecode.research.availability.removed')
  return t('kubecode.research.availability.available')
}

/** The Badge variant of a source's availability: anything but available is called out. */
export function availabilityVariant(availability: ResearchSourceAvailability): 'success' | 'warning' {
  return availability === 'available' ? 'success' : 'warning'
}

export function findingKindLabel(t: Translator, kind: ResearchFindingKind): string {
  switch (kind) {
    case 'attempt': return t('kubecode.research.findingKind.attempt')
    case 'limitation': return t('kubecode.research.findingKind.limitation')
    case 'open_question': return t('kubecode.research.findingKind.openQuestion')
    default: return t('kubecode.research.findingKind.finding')
  }
}

export function sourceKindLabel(t: Translator, kind: ResearchSourceKind): string {
  switch (kind) {
    case 'run': return t('kubecode.research.sourceKind.run')
    case 'team': return t('kubecode.research.sourceKind.team')
    case 'team_task': return t('kubecode.research.sourceKind.teamTask')
    case 'file': return t('kubecode.research.sourceKind.file')
    case 'import': return t('kubecode.research.sourceKind.import')
    default: return t('kubecode.research.sourceKind.session')
  }
}

export function phaseLabel(t: Translator, phase: ResearchRoundPhase): string {
  switch (phase) {
    case 'created': return t('kubecode.research.phase.created')
    case 'session_ready': return t('kubecode.research.phase.sessionReady')
    case 'team_created': return t('kubecode.research.phase.teamCreated')
    default: return t('kubecode.research.phase.started')
  }
}

export function agentLabel(id: string): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  if (id === 'codex') return 'Codex'
  return id
}

export function entryKindLabel(t: Translator, kind: ResearchEntry['kind']): string {
  switch (kind) {
    case 'decision': return t('kubecode.research.entryKind.decision')
    case 'proposal': return t('kubecode.research.entryKind.proposal')
    case 'observation': return t('kubecode.research.entryKind.observation')
    default: return t('kubecode.research.entryKind.note')
  }
}

export function authorLabel(t: Translator, author: ResearchEntry['author_kind']): string {
  if (author === 'agent') return t('kubecode.research.author.agent')
  if (author === 'system') return t('kubecode.research.author.system')
  return t('kubecode.research.author.researcher')
}
