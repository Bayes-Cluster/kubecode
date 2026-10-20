/**
 * What a Workspace search covers (ADR 0231 §2): explicit sections, each a set
 * of record kinds, always sent by name. The conversation itself and single
 * Session turns are never results; execution history is searched only when
 * chosen. Pure.
 */

import type { TranslationKey, Translator } from '@/lib/i18n'
import type { WorkspaceObjectKind } from '@/kubecode/icons/workspaceIcons'

import type { ProjectContextKind } from '../api'

export type ResourceSection = 'tasks' | 'findings' | 'evidence' | 'discussions' | 'files' | 'history'

export const RESOURCE_SECTIONS: Record<ResourceSection, {
  kinds: ProjectContextKind[]
  label: TranslationKey
  icon: WorkspaceObjectKind
  byDefault: boolean
}> = {
  tasks: { kinds: ['research'], label: 'kubecode.search.section.tasks', icon: 'task', byDefault: true },
  findings: { kinds: ['finding'], label: 'kubecode.search.section.findings', icon: 'finding', byDefault: true },
  evidence: {
    kinds: ['experiment', 'artifact'], label: 'kubecode.search.section.evidence', icon: 'experiment', byDefault: true,
  },
  discussions: {
    kinds: ['import', 'thread'], label: 'kubecode.search.section.discussions', icon: 'discussion', byDefault: true,
  },
  files: { kinds: ['file'], label: 'kubecode.search.section.files', icon: 'file', byDefault: true },
  history: {
    kinds: ['session', 'team', 'team_task', 'work', 'round'],
    label: 'kubecode.search.section.history',
    icon: 'session',
    byDefault: false,
  },
}

export const RESOURCE_SECTION_ORDER: ResourceSection[] = ['tasks', 'findings', 'evidence', 'discussions', 'files', 'history']

export const DEFAULT_SECTIONS: ResourceSection[] = RESOURCE_SECTION_ORDER.filter((section) => RESOURCE_SECTIONS[section].byDefault)

/** The kinds to search, in section order; empty when no section is chosen (nothing is searched). */
export function kindsFor(sections: readonly ResourceSection[]): ProjectContextKind[] {
  return RESOURCE_SECTION_ORDER.filter((section) => sections.includes(section))
    .flatMap((section) => RESOURCE_SECTIONS[section].kinds)
}

export function sectionOf(kind: ProjectContextKind): ResourceSection | null {
  return RESOURCE_SECTION_ORDER.find((section) => RESOURCE_SECTIONS[section].kinds.includes(kind)) ?? null
}

/** The sections in words, as a list in the app's language. */
export function sectionList(sections: readonly ResourceSection[], t: Translator, locale: string): string {
  const names = RESOURCE_SECTION_ORDER.filter((section) => sections.includes(section))
    .map((section) => t(RESOURCE_SECTIONS[section].label))
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names)
}

/** "Searching Tasks and Files in Pruning lab." */
export function describeScope(
  sections: readonly ResourceSection[],
  workspaceName: string,
  t: Translator,
  locale: string,
): string {
  return t('kubecode.search.scope', { sections: sectionList(sections, t, locale), workspace: workspaceName })
}
