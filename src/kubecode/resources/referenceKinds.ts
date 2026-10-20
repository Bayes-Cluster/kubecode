/**
 * How a Workspace record is named, versioned, previewed, and gone to
 * (ADR 0231 §4–§5). Pure: no React, no requests.
 */

import type { Translator } from '@/lib/i18n'

import type { ProjectContextProvenance, ProjectContextRef } from '../api'
import type { InspectorEntry } from '../app/location/inspector'
import type { WorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { kindLabelKey } from '../references/referenceLabels'

export { kindLabelKey }

const HEX = /^[0-9a-f]{16,}$/i
const NUMBER = /^\d+$/

/**
 * A cited version in words. Revisions are change fingerprints, not an order:
 * a Task's brief has a number, a file or artifact a digest (a large file only
 * its size and time), and a record with no meaningful version shows none.
 * A raw fingerprint is never shown.
 */
export function formatVersion(
  kind: ProjectContextRef['kind'],
  revision: string | null | undefined,
  t: Translator,
): string | undefined {
  if (!revision) return undefined
  if (kind === 'finding') return undefined
  if (revision.startsWith('large:')) return t('kubecode.reference.version.large')
  if (NUMBER.test(revision)) {
    return kind === 'research'
      ? t('kubecode.reference.version.brief', { revision })
      : t('kubecode.reference.version.number', { revision })
  }
  if (HEX.test(revision)) return t('kubecode.reference.version.digest', { revision: revision.slice(0, 7).toLowerCase() })
  return undefined
}

/** A name for a record whose title is not known: a file's own name, else its kind. Never an id. */
export function fallbackTitle(ref: Pick<ProjectContextRef, 'kind' | 'id'>, t: Translator): string {
  if (ref.kind === 'file') return ref.id.split('/').filter(Boolean).pop() ?? ref.id
  return t('kubecode.reference.untitled', { kind: t(kindLabelKey(ref.kind)) })
}

/** A row's `data-focus-key`, which the inspector returns focus to (ADR 0228 §3). */
export function resourceFocusKey(ref: Pick<ProjectContextRef, 'kind' | 'id'>): string {
  return `resource:${ref.kind}:${ref.id}`
}

/**
 * What choosing a result opens in the inspector: a Task as a Task, and every
 * other record as a live preview. While a message waits for a reference, a
 * Task opens as its brief, so it can be added like anything else. Chips keep
 * the shared reference mapping (`openReference`); this is for results only.
 */
export function previewEntryFor(ref: ProjectContextRef, options: { attaching?: boolean } = {}): InspectorEntry {
  if (ref.kind === 'research' && !options.attaching) return { kind: 'task', id: ref.id }
  return { kind: 'resource', ref: { kind: ref.kind, id: ref.id, revision: null } }
}

export type GoToTarget = {
  label: 'kubecode.resources.goTo.task' | 'kubecode.resources.goTo.thread' | 'kubecode.resources.goTo.session'
  run(navigation: WorkspaceNavigation): void
}

/** Where a record lives, when that is somewhere other than its preview. */
export function goToTargetFor(
  ref: Pick<ProjectContextRef, 'kind' | 'id'>,
  provenance: Pick<ProjectContextProvenance, 'research_id'> | null | undefined,
): GoToTarget | null {
  if (ref.kind === 'thread') {
    return {
      label: 'kubecode.resources.goTo.thread',
      // The shared mapping: the Thread in General, without General's remembered Task or filter.
      run: (navigation) => navigation.openReference({ kind: 'thread', id: ref.id }),
    }
  }
  if (ref.kind === 'session') {
    return { label: 'kubecode.resources.goTo.session', run: (navigation) => navigation.openReference({ kind: 'session', id: ref.id }) }
  }
  const task = ref.kind === 'research' ? ref.id : provenance?.research_id
  if (task) {
    return {
      label: 'kubecode.resources.goTo.task',
      run: (navigation) => navigation.inspect({ kind: 'task', id: task }, { mode: 'push' }),
    }
  }
  return null
}
