import { useCallback, useContext, useId, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { IconButton } from '@/components/workspace/IconButton'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'
import { cn } from '@/lib/utils'

import type { KubecodeApi, ProjectContextRef, WorkspaceEvent } from '../api'
import { usePlaceState } from '../app/location/placeMemory'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { useAttachTarget } from './attachTarget'
import { MAX_DRAFT_REFERENCES, type AttachResult, type DraftReference } from './draftReferences'
import { ReaderEmpty, ReaderNotice } from './ReaderStates'
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
  const resultsList = useRef<HTMLDivElement>(null)
  // On a narrow screen the preview replaces the results, which lose their scroll: it is put back on Back.
  const resultsScroll = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (previewed || resultsScroll.current === null || !resultsList.current) return
    resultsList.current.scrollTop = resultsScroll.current
    resultsScroll.current = null
  }, [previewed])
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
        className="kubecode-add-context-dialog @container max-h-[calc(100dvh-32px)] w-[min(960px,calc(100vw-32px))] max-w-[min(960px,calc(100vw-32px))] overflow-y-auto sm:max-w-[min(960px,calc(100vw-32px))] max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:rounded-none"
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
        <div className="grid min-h-0 gap-3 @[720px]:grid-cols-2" data-step={previewed ? 'preview' : 'list'}>
          <div className={cn('flex min-h-0 min-w-0 flex-col gap-2', previewed && '@max-[719px]:hidden')} ref={searchArea}>
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
              listRef={resultsList}
              onChoose={(result) => {
                resultsScroll.current = resultsList.current?.scrollTop ?? null
                setRefusal(null)
                setShown(null)
                setPreviewed({ kind: result.item.ref.kind, id: result.item.ref.id, title: result.item.title })
              }}
            />
            <p className="text-xs text-muted-foreground">{t('kubecode.addContext.keys')}</p>
          </div>
          <section
            aria-label={previewed?.title ?? t('kubecode.addContext.choose')}
            className={cn('flex min-h-0 min-w-0 flex-col gap-2', !previewed && '@max-[719px]:hidden')}
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
                  className="self-start @[720px]:hidden"
                  icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.back.Icon} />}
                  label={t('kubecode.addContext.backToResults')}
                  onClick={backToResults}
                />
                {previewed.kind === 'research' && (
                  <ReaderNotice live={false}>{t('kubecode.resources.taskNote')}</ReaderNotice>
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
                <div className="sticky bottom-0 flex flex-wrap items-center gap-2 bg-background pt-2">
                  <Button
                    aria-describedby={reason ? reasonId : undefined}
                    disabled={reason !== null}
                    type="button"
                    onClick={attachShown}
                  >
                    {t('kubecode.addContext.attachVersion')}
                  </Button>
                  {reason && <p className="text-xs text-muted-foreground" id={reasonId}>{reason}</p>}
                </div>
              </>
            ) : (
              <ReaderEmpty>{t('kubecode.addContext.choose')}</ReaderEmpty>
            )}
          </section>
        </div>
        {refusal && <ReaderNotice failed>{refusal}</ReaderNotice>}
        {navigation && (
        <DialogFooter>
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
        </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
