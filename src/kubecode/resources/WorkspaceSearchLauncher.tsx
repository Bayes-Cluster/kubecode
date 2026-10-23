import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { IconButton } from '@/components/workspace/IconButton'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, WorkspaceEvent } from '../api'
import { placeKey, usePlaceMemory } from '../app/location/placeMemory'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { previewEntryFor } from './referenceKinds'
import { WorkspaceSearch } from './WorkspaceSearch'

export type WorkspaceSearchLauncherProps = {
  api: KubecodeApi
  workspaceName: string
  events: readonly WorkspaceEvent[]
  t: Translator
  locale?: string
  /** A phone: the search opens Resources instead of a popover. */
  narrow: boolean
}

export const QUICK_SEARCH_KEY = (projectId: string) => `${projectId}|quick-search`

/**
 * The titlebar's Workspace search (ADR 0231 §2), apart from Session search: a
 * popover with the same search, scope note, and top results. Choosing one
 * previews it in the inspector over the current view; "See all results"
 * carries the words to Resources. On a phone it is a button to Resources.
 */
export function WorkspaceSearchLauncher({ api, events, locale, narrow, t, workspaceName }: WorkspaceSearchLauncherProps) {
  const navigation = useWorkspaceNavigation()
  const memory = usePlaceMemory()
  const [open, setOpen] = useState(false)
  const { projectId } = navigation
  const label = t('kubecode.search.label', { workspace: workspaceName })
  const openResources = () => navigation.openPlace({ view: 'resources' }, { focus: 'resources:search' })

  if (narrow) {
    return (
      <IconButton
        icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.search.Icon} />}
        label={t('kubecode.search.searchWorkspace')}
        onClick={openResources}
      />
    )
  }
  const quickKey = QUICK_SEARCH_KEY(projectId)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button aria-label={label} className="w-full max-w-lg min-w-0 justify-start" type="button" variant="outline">
          <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.search.Icon} />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        aria-label={label}
        className="flex max-h-[min(70vh,560px)] w-[min(36rem,calc(100vw-32px))] flex-col p-3"
      >
        <WorkspaceSearch
          api={api}
          autoFocus
          events={events}
          footer={(
            <Button
              className="w-full"
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                // The words go with the researcher; nothing else of the quick search does.
                memory?.set(`${placeKey.view(projectId, 'resources')}#query`, memory.get(`${quickKey}#query`) ?? '')
                setOpen(false)
                openResources()
              }}
            >
              {t('kubecode.search.seeAll')}
            </Button>
          )}
          locale={locale}
          memoryKey={quickKey}
          mode="quick"
          projectId={projectId}
          t={t}
          workspaceName={workspaceName}
          onChoose={(result) => {
            setOpen(false)
            navigation.inspect(previewEntryFor(result.item.ref), { mode: 'reset' })
          }}
          onEscape={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
