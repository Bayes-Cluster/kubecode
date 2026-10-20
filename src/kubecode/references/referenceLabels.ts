import type { ReferenceState } from '@/components/workspace/ReferenceChip'
import type { WorkspaceObjectKind } from '@/kubecode/icons/workspaceIcons'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type {
  ChannelThread,
  Conversation,
  ProjectContextKind,
  ProjectContextRef,
  ResearchSummary,
} from '../api'
import { PROJECT_CONTEXT_KIND_LABELS } from '../projectContext'

/** What a reference chip shows: never a bare id (ADR 0227). */
export type ReferenceLabel = {
  kind: WorkspaceObjectKind
  kindLabel: string
  title: string
  version?: string
  state?: ReferenceState
}

/**
 * Names a reference. The browser's own source knows what it has loaded;
 * server titles and changed or removed states replace it later (#219).
 */
export type ReferenceLabelSource = (ref: ProjectContextRef) => ReferenceLabel

const OBJECT_KINDS: Record<ProjectContextKind, WorkspaceObjectKind> = {
  research: 'task',
  round: 'task',
  import: 'discussion',
  finding: 'finding',
  session: 'session',
  session_turn: 'session',
  team: 'session',
  team_task: 'workItem',
  experiment: 'experiment',
  artifact: 'artifact',
  work: 'workItem',
  thread: 'thread',
  channel: 'message',
  file: 'file',
}

/** The shared glyph for a kind of reference. */
export function objectKindOf(kind: ProjectContextKind): WorkspaceObjectKind {
  return OBJECT_KINDS[kind]
}

/**
 * A kind in the Workspace's words: the shared vocabulary where it has one
 * (Task, File, Finding…), else the reader's own kind name.
 */
const VOCABULARY: Partial<Record<ProjectContextKind, TranslationKey>> = {
  research: 'kubecode.vocab.object.task',
  file: 'kubecode.vocab.object.file',
  finding: 'kubecode.vocab.object.finding',
  experiment: 'kubecode.vocab.object.experiment',
  artifact: 'kubecode.vocab.object.artifact',
  import: 'kubecode.vocab.object.discussion',
  thread: 'kubecode.vocab.object.thread',
  session: 'kubecode.vocab.object.session',
}

export function kindLabelKey(kind: ProjectContextKind): TranslationKey {
  return VOCABULARY[kind] ?? PROJECT_CONTEXT_KIND_LABELS[kind]
}

export function localReferenceLabels({ picked, research, sessions, t, threads }: {
  research: readonly ResearchSummary[]
  threads: readonly ChannelThread[]
  sessions: readonly Conversation[]
  picked: ReadonlyArray<{ ref: Pick<ProjectContextRef, 'kind' | 'id'>; title: string }>
  t: Translator
}): ReferenceLabelSource {
  return (ref) => {
    const kindLabel = t(kindLabelKey(ref.kind))
    const known = ref.kind === 'research' ? research.find((item) => item.id === ref.id)?.title
      : ref.kind === 'thread' ? threads.find((item) => item.id === ref.id)?.title
        : ref.kind === 'session' ? sessions.find((item) => item.id === ref.id)?.title
          : undefined
    const title = known
      // A file is named by its path: that is its title everywhere.
      || (ref.kind === 'file' ? ref.id : undefined)
      || picked.find((item) => item.ref.kind === ref.kind && item.ref.id === ref.id)?.title
      || t('kubecode.reference.untitled', { kind: kindLabel })
    return { kind: objectKindOf(ref.kind), kindLabel, title }
  }
}
