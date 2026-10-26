import type { ReactNode } from 'react'

import { ChevronDownIcon } from 'lucide-react'

import { SourceList, type SourceItem } from '@/components/agent-ui'
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import type { Translator } from '@/lib/i18n'

import type { ProjectContextRef } from '../api'
import { formatVersion, fallbackTitle, kindLabelKey } from './referenceKinds'
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
 * 0233, ADR 0236) whose content is the shared affectUI source presentation
 * (ADR 0257, slice B): one card per reference with its cited revision and
 * resolved availability, a preview that crossfades between selections, and
 * the same open action for pointer, keyboard and touch. The trigger counts
 * the sources and, when any changed or is gone, says how many need a look,
 * so a collapsed list still warns.
 */
export function ReferenceSources<R extends CitedRef>({ leading, onOpen, references, t }: ReferenceSourcesProps<R>) {
  const statuses = useReferenceStatus(references.map((reference) => reference.ref))
  const attention = statuses.filter((status) => status.status === 'ready' && status.availability !== 'available').length
  const count = t('kubecode.reference.sources', { count: references.length })
  const label = attention > 0 ? `${count} · ${t('kubecode.reference.sourcesAttention', { count: attention })}` : count
  const items: SourceItem[] = references.map((reference, index) => {
    const status = statuses[index]
    const state =
      status.status === 'error'
        ? { tone: 'error' as const, label: t('kubecode.reference.state.unavailable') }
        : status.status === 'ready' && status.availability === 'changed'
          ? { tone: 'warn' as const, label: t('kubecode.reference.state.changedSinceCited') }
          : status.status === 'ready' && status.availability === 'removed'
            ? { tone: 'error' as const, label: t('kubecode.reference.state.removed') }
            : undefined
    const title =
      status.status === 'ready'
        ? status.title ?? reference.title ?? fallbackTitle(reference.ref, t)
        : reference.title ?? fallbackTitle(reference.ref, t)
    return {
      id: `${reference.ref.kind}:${reference.ref.id}`,
      kindLabel: t(kindLabelKey(reference.ref.kind)),
      title,
      versionLabel: formatVersion(reference.ref.kind, reference.ref.revision ?? null, t),
      ...(state ? { state } : {}),
    }
  })
  return (
    // The official Sources (ADR 0242); each source is a typed reference that opens in the Workspace, not a link.
    <Sources className="mb-0 min-w-0" defaultOpen>
      <SourcesTrigger className="group/sources" count={references.length}>
        <span>{label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform group-data-[state=open]/sources:rotate-180" />
      </SourcesTrigger>
      <SourcesContent className="mt-2 w-full">
        <div className="flex min-w-0 flex-col gap-2">
          {leading && <div className="flex min-w-0 flex-wrap gap-1">{leading}</div>}
          <SourceList
            aria-label={t('kubecode.channel.references')}
            closeLabel={t('kubecode.vocab.command.close')}
            onOpen={(id) => {
              const reference = references.find((candidate) => `${candidate.ref.kind}:${candidate.ref.id}` === id)
              if (reference) onOpen(reference.ref)
            }}
            openLabel={t('kubecode.reference.open')}
            previewLabel={t('kubecode.channel.references')}
            sources={items}
          />
        </div>
      </SourcesContent>
    </Sources>
  )
}
