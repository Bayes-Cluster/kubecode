import { useCallback, useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'

import type { ProjectContextDocument, ProjectContextItem } from '../api'
import { useInspectorEntry, useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import type { InspectorEntry } from '../app/location/inspector'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { objectKindOf } from '../references/referenceLabels'
import { useAttachToDraft } from './attachTarget'
import { attachAnnouncement, MAX_DRAFT_REFERENCES } from './draftReferences'
import { RecordPreview, type DisplayedRecord } from './RecordPreview'
import { fallbackTitle, formatVersion, goToTargetFor, kindLabelKey, previewEntryFor } from './referenceKinds'

/**
 * A Workspace record in the inspector, read live through the one record
 * reader (ADR 0231 §4), beside the list it was chosen from. It offers to add
 * the version on screen to a General draft, and to go where the record lives;
 * it never starts work.
 */
export function ResourcePanel({ entry, projectId }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'resource' }>>) {
  const { api, events, t } = useInspectorServices()
  const { push } = useInspectorEntry()
  const navigation = useWorkspaceNavigation()
  const attachment = useAttachToDraft(t)
  const { id, kind } = entry.ref
  // The version a Task or message cited, when the record was opened from a citation.
  const cited = entry.ref.revision ?? null
  // What is on screen now, and nothing else: forgotten whenever the preview reads again or fails.
  const [displayed, setDisplayed] = useState<DisplayedRecord | null>(null)
  const shown = displayed && displayed.kind === kind && displayed.id === id ? displayed : null
  const [removed, setRemoved] = useState(false)
  const [provenance, setProvenance] = useState<ProjectContextDocument['provenance'] | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const describedBy = useId()

  const onDisplayed = useCallback((next: DisplayedRecord) => {
    setDisplayed(next)
    setRemoved(false)
  }, [])
  const onCleared = useCallback(() => setDisplayed(null), [])
  const onLoaded = useCallback((doc: ProjectContextDocument) => setProvenance(doc.provenance), [])
  const onFailed = useCallback((reason: 'failed' | 'removed') => {
    setDisplayed(null)
    if (reason === 'removed') setRemoved(true)
  }, [])
  const onFollow = useCallback((item: ProjectContextItem) => {
    push(previewEntryFor(item.ref), { from: `related:${item.ref.kind}:${item.ref.id}` })
  }, [push])

  // Gone or unreadable here: Resources is where to look for it, or for what replaced it.
  const recovery = navigation.location.place.view === 'resources' ? undefined : {
    label: t('kubecode.resources.findInResources'),
    run: () => navigation.openPlace({ view: 'resources' }, { inspector: 'keep' }),
  }
  const title = shown?.title ?? fallbackTitle(entry.ref, t)
  const goTo = goToTargetFor(entry.ref, provenance)
  const version = shown ? formatVersion(kind, shown.revision, t) : undefined
  const reference = shown ? { kind, id, revision: shown.revision } : null
  const already = reference !== null && attachment !== null && attachment.has(reference)
  const full = attachment?.full === true && kind !== 'research'
  const reason = removed ? t('kubecode.resources.removedCannotAdd')
    : !shown ? t('kubecode.resources.waitForPreview')
    : already ? t('kubecode.resources.alreadyAdded')
      : full ? t('kubecode.resources.limitReached', { count: MAX_DRAFT_REFERENCES })
        : t('kubecode.resources.addsVersion', { place: attachment?.place ?? '' })

  const add = () => {
    if (!attachment || !reference || !shown || removed) return
    const announcement = attachAnnouncement(attachment.attach({ ref: reference, title: shown.title, seen: 'previewed' }))
    if (announcement) setAnnouncement(t(announcement, { title: shown.title }))
  }

  return (
    <InspectorPanel
      actions={(
        <>
          {attachment && (
            <Button
              aria-describedby={describedBy}
              disabled={!shown || removed || already || full}
              size="sm"
              type="button"
              onClick={add}
            >
              <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.addContext.Icon} />
              {t(attachment.label === 'general' ? 'kubecode.resources.addToGeneral' : 'kubecode.resources.addToMessage')}
            </Button>
          )}
          {goTo && (
            <Button size="sm" type="button" variant="outline" onClick={() => goTo.run(navigation)}>
              {t(goTo.label)}
            </Button>
          )}
        </>
      )}
      icon={<Icon role="navigation" source={WORKSPACE_OBJECT_ICONS[objectKindOf(kind)].Icon} />}
      meta={(
        <>
          <StatusBadge tone="muted">{t(kindLabelKey(kind))}</StatusBadge>
          {version && <StatusBadge tone="muted">{version}</StatusBadge>}
        </>
      )}
      recovery={recovery && (
        <Button size="xs" type="button" variant="outline" onClick={recovery.run}>{recovery.label}</Button>
      )}
      status={removed ? 'unavailable' : 'ready'}
      title={title}
    >
      {attachment && <p className="kubecode-research-muted" id={describedBy}>{reason}</p>}
      {kind === 'research' && attachment && <p className="kubecode-research-notice">{t('kubecode.resources.taskNote')}</p>}
      <p className="sr-only" role="status">{announcement}</p>
      <RecordPreview
        api={api}
        cited={cited}
        events={events}
        key={`${kind}:${id}`}
        projectId={projectId}
        recovery={recovery}
        t={t}
        target={{ kind, id }}
        onCleared={onCleared}
        onDisplayed={onDisplayed}
        onFailed={onFailed}
        onFollow={onFollow}
        onLoaded={onLoaded}
      />
    </InspectorPanel>
  )
}
