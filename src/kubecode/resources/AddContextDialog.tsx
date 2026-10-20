import { useCallback, useContext, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { IconButton } from '@/components/workspace/IconButton'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, ProjectContextRef, WorkspaceEvent } from '../api'
import { usePlaceState } from '../app/location/placeMemory'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { useAttachTarget } from './attachTarget'
import { MAX_DRAFT_REFERENCES, type AttachResult, type DraftReference } from './draftReferences'
import { RecordPreview, type DisplayedRecord } from './RecordPreview'
import type { SearchResult } from './useWorkspaceSearch'
import { WorkspaceSearch } from './WorkspaceSearch'

type Previewed = { kind: ProjectContextRef['kind']; id: string; title: string }

export type AddContextDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  api: KubecodeApi
  projectId: string
  workspaceName: string
  events: readonly WorkspaceEvent[]
  t: Translator
  locale?: string
  /** The place whose draft this is (`placeKey.general`): the search and preview are kept under it. */
  placeMemoryKey: string
  /** General's Task filter, so Browse in Resources returns to this very draft. */
  filter: string | null
  /** Adds the reference to the draft. */
  onAttach: (reference: DraftReference) => AttachResult
  /** Whether the draft already cites this version. */
  has: (ref: DraftReference['ref']) => boolean
  full: boolean
  /** Restores the composer's caret instead of Radix's default focus return. */
  onCloseAutoFocus?: (event: Event) => void
  /** Before the dialog hands the researcher to Resources, so the composer can keep its caret. */
  onLeave?: () => void
}

/**
 * Finds something to cite from a General draft (ADR 0231 §5): the Workspace
 * search, and beside it (or after it, on a narrow screen) the one record
 * preview. "Attach this version" attaches the version on screen; Enter on a
 * result attaches the current one, stamped when attached. Nothing is copied
 * and nothing starts. The search and preview are kept for this draft.
 */
export function AddContextDialog({
  api,
  events,
  filter,
  full,
  has,
  locale,
  onAttach,
  onCloseAutoFocus,
  onLeave,
  onOpenChange,
  open,
  placeMemoryKey,
  projectId,
  t,
  workspaceName,
}: AddContextDialogProps) {
  const navigation = useContext(WorkspaceNavigationContext)
  const [, setAttachTarget] = useAttachTarget(projectId)
  const memoryKey = `${placeMemoryKey}#search`
  const [previewed, setPreviewed] = usePlaceState<Previewed | null>(`${memoryKey}#preview`, null)
  // What the preview has on screen now, and nothing else: forgotten whenever it reads again, fails, or closes.
  const [shown, setShown] = useState<DisplayedRecord | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const reasonId = useId()
  const searchArea = useRef<HTMLDivElement>(null)
  const shownHere = shown && previewed && shown.kind === previewed.kind && shown.id === previewed.id ? shown : null
  const reference = shownHere && previewed ? { kind: previewed.kind, id: previewed.id, revision: shownHere.revision } : null
  const already = reference !== null && has(reference)
  const blockedByLimit = full && previewed?.kind !== 'research'
  const reason = !shownHere ? t('kubecode.resources.waitForPreview')
    : already ? t('kubecode.resources.alreadyAdded')
      : blockedByLimit ? t('kubecode.resources.limitReached', { count: MAX_DRAFT_REFERENCES })
        : null

  const finish = (result: AttachResult) => {
    if (result === 'full') {
      setRefusal(t('kubecode.resources.limitReached', { count: MAX_DRAFT_REFERENCES }))
      return
    }
    setRefusal(null)
    changeOpen(false)
  }
  const attachShown = () => {
    if (!reference || !shownHere || reason) return
    finish(onAttach({ ref: reference, title: shownHere.title, seen: 'previewed' }))
  }
  const attachCurrent = async (result: SearchResult) => {
    const { item } = result
    try {
      const [resolved] = await api.resolveProjectContext(projectId, [{ kind: item.ref.kind, id: item.ref.id }])
      if (!resolved || resolved.availability === 'removed') {
        setRefusal(t('kubecode.resources.removedCannotAdd'))
        return
      }
      finish(onAttach({
        ref: { kind: item.ref.kind, id: item.ref.id, revision: resolved.current_revision },
        title: resolved.title ?? item.title,
        seen: 'listed',
      }))
    } catch {
      setRefusal(t('kubecode.search.failed'))
    }
  }
  const backToResults = () => {
    setPreviewed(null)
    setShown(null)
    searchArea.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus()
  }
  const onDisplayed = useCallback((displayed: DisplayedRecord) => setShown(displayed), [])
  const forgetShown = useCallback(() => setShown(null), [])
  const changeOpen = (next: boolean) => {
    // Reopened, the preview reads again: the version seen before is not on screen yet.
    if (!next) setShown(null)
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="kubecode-add-context-dialog"
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          // Escape leaves the preview first, then closes.
          if (previewed) {
            event.preventDefault()
            backToResults()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('kubecode.vocab.command.addContext')}</DialogTitle>
          <DialogDescription>{t('kubecode.addContext.hint')}</DialogDescription>
        </DialogHeader>
        <div className="kubecode-add-context" data-step={previewed ? 'preview' : 'list'}>
          <div className="kubecode-add-context-list" ref={searchArea}>
            <WorkspaceSearch
              api={api}
              autoFocus
              events={events}
              locale={locale}
              memoryKey={memoryKey}
              mode="attach"
              projectId={projectId}
              selectedKey={previewed ? `${previewed.kind}:${previewed.id}` : null}
              t={t}
              workspaceName={workspaceName}
              onAttachCurrent={(result) => void attachCurrent(result)}
              onChoose={(result) => {
                setRefusal(null)
                setShown(null)
                setPreviewed({ kind: result.item.ref.kind, id: result.item.ref.id, title: result.item.title })
              }}
            />
            <p className="kubecode-composer-hint">{t('kubecode.addContext.keys')}</p>
          </div>
          <section
            aria-label={previewed?.title ?? t('kubecode.addContext.choose')}
            className="kubecode-add-context-preview"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                attachShown()
              }
            }}
          >
            {previewed ? (
              <>
                <IconButton
                  className="kubecode-add-context-back"
                  icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.back.Icon} />}
                  label={t('kubecode.addContext.backToResults')}
                  onClick={backToResults}
                />
                {previewed.kind === 'research' && (
                  <p className="kubecode-research-notice">{t('kubecode.resources.taskNote')}</p>
                )}
                <RecordPreview
                  api={api}
                  compact
                  events={events}
                  key={`${previewed.kind}:${previewed.id}`}
                  projectId={projectId}
                  t={t}
                  target={previewed}
                  onCleared={forgetShown}
                  onDisplayed={onDisplayed}
                  onFailed={forgetShown}
                />
                <div className="kubecode-add-context-actions">
                  <Button
                    aria-describedby={reason ? reasonId : undefined}
                    disabled={reason !== null}
                    type="button"
                    onClick={attachShown}
                  >
                    {t('kubecode.addContext.attachVersion')}
                  </Button>
                  {reason && <small className="kubecode-research-muted" id={reasonId}>{reason}</small>}
                </div>
              </>
            ) : (
              <p className="kubecode-research-muted">{t('kubecode.addContext.choose')}</p>
            )}
          </section>
        </div>
        {refusal && <p className="kubecode-research-error" role="alert">{refusal}</p>}
        {navigation && (
        <div className="kubecode-add-context-footer">
          <Button
            type="button"
            variant="link"
            onClick={() => {
              onLeave?.()
              setAttachTarget({ filter, focusKey: 'composer:general' })
              changeOpen(false)
              navigation.openPlace({ view: 'resources' }, { focus: 'resources:search' })
            }}
          >
            {t('kubecode.addContext.browseAll')}
          </Button>
        </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
