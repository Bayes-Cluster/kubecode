import type { ReactNode } from 'react'

import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements'
import type { Translator } from '@/lib/i18n'

import type { ProjectContextRef } from '../api'
import { ResourceReferenceChip } from './ResourceReferenceChip'
import { useReferenceStatus } from './referenceStatus'

type CitedRef = Pick<ProjectContextRef, 'kind' | 'id'> & { revision?: string | null }

export type ReferenceSourcesProps<R extends CitedRef = CitedRef> = {
  /** What a message cites, each with the title the page already knows. */
  references: ReadonlyArray<{ ref: R; title?: string }>
  /** Something shown first in the same list, for example the Task a message is about. */
  leading?: ReactNode
  t: Translator
  onOpen: (ref: R) => void
}

/**
 * What a sent message cites, as the AI Elements `Sources` disclosure (ADR
 * 0233, ADR 0236): open by default, each source the one version-aware
 * reference chip. The trigger counts the sources and, when any changed or
 * is gone, says how many need a look, so a collapsed list still warns.
 */
export function ReferenceSources<R extends CitedRef>({ leading, onOpen, references, t }: ReferenceSourcesProps<R>) {
  const statuses = useReferenceStatus(references.map((reference) => reference.ref))
  const attention = statuses.filter((status) => status.status === 'ready' && status.availability !== 'available').length
  const count = t('kubecode.reference.sources', { count: references.length })
  const label = attention > 0 ? `${count} · ${t('kubecode.reference.sourcesAttention', { count: attention })}` : count
  return (
    <Sources className="kubecode-reference-sources" defaultOpen>
      <SourcesTrigger label={label} />
      <SourcesContent listLabel={t('kubecode.channel.references')}>
        {leading && <Source>{leading}</Source>}
        {references.map((reference) => (
          <Source key={`${reference.ref.kind}:${reference.ref.id}`}>
            <ResourceReferenceChip
              basis="cited"
              knownTitle={reference.title}
              reference={reference.ref}
              t={t}
              onOpen={() => onOpen(reference.ref)}
            />
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  )
}
