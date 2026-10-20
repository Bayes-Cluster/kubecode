import { useRef, useState } from 'react'

import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextItem, ProjectContextRef } from '../api'
import { useScrollMemory } from '../app/location/placeMemory'
import { ComposerProjectWorkPicker, type ProjectWorkListStatus } from '../ComposerProjectWorkPicker'

export type ResourcesViewProps = {
  api: KubecodeApi
  projectId: string
  t: Translator
  /**
   * Opens the item where references open (ADR 0228 §3): a record or a Task in
   * this view's inspector, a Session, Thread, or work item where it lives.
   */
  onOpen: (reference: ProjectContextRef) => void
  /**
   * Where the place keeps the results' scroll position, the search, the kind
   * filter, and the open preview (`placeKey.view`).
   */
  stateKey?: string | null
}

/**
 * What the Workspace has produced and can cite: research, findings, work,
 * experiments, artifacts, imports, and Sessions, read-only. It is the same
 * reader the Composer's reference picker uses, so what is found here is what
 * can be cited in a message. Choosing a row previews it; the preview opens
 * the record in this view's inspector, beside the list.
 */
export function ResourcesView({ api, onOpen, projectId, stateKey = null, t }: ResourcesViewProps) {
  const results = useRef<HTMLDivElement>(null)
  // The results load after arrival: the scroll position is put back once they are in.
  const [listStatus, setListStatus] = useState<ProjectWorkListStatus>('loading')
  useScrollMemory(results, stateKey, { ready: listStatus !== 'loading' })
  return (
    <section aria-label={t('kubecode.nav.resources')} className="kubecode-resources">
      <header className="kubecode-channel-header">
        <div>
          <h2>{t('kubecode.nav.resources')}</h2>
          <p className="kubecode-research-muted">{t('kubecode.resources.subtitle')}</p>
        </div>
      </header>
      <ComposerProjectWorkPicker
        api={api}
        conversationId=""
        projectId={projectId}
        t={t}
        onListStatusChange={setListStatus}
        onOpen={(item: ProjectContextItem) => onOpen(item.ref)}
        onSelect={() => undefined}
        resultsRef={results}
        stateKey={stateKey}
      />
    </section>
  )
}
