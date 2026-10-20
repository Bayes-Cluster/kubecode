import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import type { Translator } from '@/lib/i18n'

import type { ProjectContextRef } from '../api'
import { referenceChipLabel, useReferenceStatus } from './referenceStatus'

export type ResourceReferenceChipProps = {
  reference: Pick<ProjectContextRef, 'kind' | 'id'> & { revision?: string | null }
  /** `cited`: in a sent message; `attached`: in a draft. */
  basis: 'cited' | 'attached'
  /** What this page already calls it, until the server names it. */
  knownTitle?: string
  t: Translator
  onOpen?: () => void
  onRemove?: () => void
  removeLabel?: string
}

/**
 * A reference as everyone sees it (ADR 0231 §5): kind, title, cited version,
 * and in words whether it changed, no longer exists, or is not available
 * here, resolved against the server. Never an id.
 */
export function ResourceReferenceChip({ basis, knownTitle, onOpen, onRemove, reference, removeLabel, t }: ResourceReferenceChipProps) {
  const [status] = useReferenceStatus([reference])
  const label = referenceChipLabel(reference, status, t, { basis, knownTitle })
  const removal = onRemove && removeLabel ? { onRemove, removeLabel } : {}
  return (
    // `display: contents`: the host only names the chip for focus moves (`data-reference`).
    <span className="kubecode-reference-chip-host" data-reference={`${reference.kind}:${reference.id}`}>
      <ReferenceChip {...label} {...removal} onOpen={onOpen} />
    </span>
  )
}
