import type { ReactNode } from 'react'

import { WORKSPACE_OBJECT_ICONS, type WorkspaceObjectKind } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { MemberIdentity } from '../MemberIdentity'
import { ReferenceChip, type ReferenceState } from '../ReferenceChip'
import type { FixtureMember } from './fixtures'
import type { PrototypeRequest } from './prototypeRoute'

export type ScreenProps = {
  request: PrototypeRequest
  t: Translator
  /** Opens another prototype screen. */
  go: (change: Partial<PrototypeRequest>) => void
}

export type ScreenParts = { main: ReactNode; inspector: ReactNode; inspectorLabel: string }

/** A member as the author of a message, with the time as meta. */
export function Author({ activity, member, time }: { member: FixtureMember; time: string; activity?: ReactNode }) {
  return (
    <MemberIdentity
      activity={activity}
      handle={member.handle}
      meta={<time>{time}</time>}
      name={member.name}
      role={member.role}
      roleLabel={member.responsibility}
    />
  )
}

/** A fixture reference: opening it only notes that this is a prototype. */
export function FixtureReference({
  kind,
  onRemove,
  removeLabel,
  state,
  t,
  title,
  version,
}: {
  kind: WorkspaceObjectKind
  title: string
  version?: string
  state?: ReferenceState
  t: Translator
  onRemove?: () => void
  removeLabel?: string
}) {
  const common = {
    kind,
    kindLabel: t(WORKSPACE_OBJECT_ICONS[kind].labelKey),
    state,
    title,
    version,
  }
  return onRemove && removeLabel
    ? <ReferenceChip {...common} onRemove={onRemove} removeLabel={removeLabel} />
    : <ReferenceChip {...common} />
}
