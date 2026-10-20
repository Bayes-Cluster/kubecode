import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextItem, ProjectContextRef } from '../api'
import { ComposerProjectWorkPicker } from '../ComposerProjectWorkPicker'

export type ResourcesViewProps = {
  api: KubecodeApi
  projectId: string
  t: Translator
  /** Goes to the item itself: its Task, Session, Thread, or the board. */
  onOpen: (reference: ProjectContextRef) => void
  /** Which kinds of record have somewhere to go. */
  canOpen: (reference: ProjectContextRef) => boolean
}

/**
 * What the Workspace has produced and can cite: research, findings, work,
 * experiments, artifacts, imports, and Sessions, read-only. It is the same
 * reader the Composer's reference picker uses, so what is found here is what
 * can be cited in a message. Choosing a row previews it; the preview offers
 * going to the record.
 */
export function ResourcesView({ api, canOpen, onOpen, projectId, t }: ResourcesViewProps) {
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
        canOpen={(item: ProjectContextItem) => canOpen(item.ref)}
        onOpen={(item: ProjectContextItem) => onOpen(item.ref)}
        onSelect={() => undefined}
      />
    </section>
  )
}
