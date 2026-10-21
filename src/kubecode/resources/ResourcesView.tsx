import { useContext, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import { DestinationHeader } from '../app/DestinationHeader'

import type { KubecodeApi, WorkspaceEvent } from '../api'
import { InspectorServicesContext } from '../app/inspector/inspectorContext'
import { placeKey, useScrollMemory } from '../app/location/placeMemory'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { useAttachTarget } from './attachTarget'
import { previewEntryFor } from './referenceKinds'
import type { WorkspaceSearchState } from './useWorkspaceSearch'
import { WorkspaceSearch } from './WorkspaceSearch'

export type ResourcesViewProps = {
  api: KubecodeApi
  projectId: string
  workspaceName: string
  events: readonly WorkspaceEvent[]
  t: Translator
  locale?: string
}

/**
 * Everything the Workspace has produced and can cite, as a preview-first
 * library (ADR 0231 §4): choosing a result opens it in the inspector beside
 * the list (or over it on a phone), and never leaves the view. Going where a
 * record lives is an action inside its preview. While a General draft waits
 * for a reference, the view says so and offers the way back.
 */
export function ResourcesView({ api, events, locale, projectId, t, workspaceName }: ResourcesViewProps) {
  const navigation = useWorkspaceNavigation()
  const services = useContext(InspectorServicesContext)
  const [target, setTarget] = useAttachTarget(projectId)
  const results = useRef<HTMLDivElement>(null)
  const memoryKey = placeKey.view(projectId, 'resources')
  // The results load after arrival: the scroll position is put back once they are in.
  const [status, setStatus] = useState<WorkspaceSearchState['status']>('loading')
  useScrollMemory(results, memoryKey, { ready: status === 'ready' || status === 'idle' || status === 'error' })
  const shown = navigation.location.inspector[0]
  const selectedKey = shown?.kind === 'resource' ? `${shown.ref.kind}:${shown.ref.id}`
    : shown?.kind === 'task' ? `research:${shown.id}` : null
  const cards = services?.taskBoard?.board?.cards ?? []

  return (
    <section aria-label={t('kubecode.nav.resources')} className="kubecode-resources">
      <DestinationHeader
        className="kubecode-channel-header"
        description={t('kubecode.resources.description')}
        destination="resources"
        t={t}
      />
      {target && (
        <div className="kubecode-attach-bar" role="status">
          <span>{t('kubecode.resources.attachBanner', { place: t('kubecode.resources.placeGeneral') })}</span>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              setTarget(null)
              navigation.openPlace({ view: 'general', filter: target.filter }, { inspector: 'closed', focus: target.focusKey })
            }}
          >
            {t('kubecode.resources.returnToMessage')}
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setTarget(null)}>
            {t('kubecode.resources.stopAdding')}
          </Button>
        </div>
      )}
      <WorkspaceSearch
        api={api}
        events={events}
        inputFocusKey="resources:search"
        listRef={results}
        locale={locale}
        memoryKey={memoryKey}
        mode="browse"
        projectId={projectId}
        selectedKey={selectedKey}
        t={t}
        taskTitle={(id) => cards.find((card) => card.id === id)?.title}
        workspaceName={workspaceName}
        onChoose={(result, focusKey) => {
          navigation.inspect(previewEntryFor(result.item.ref, { attaching: target !== null }), { mode: 'reset', from: focusKey })
        }}
        onStatusChange={setStatus}
      />
    </section>
  )
}
