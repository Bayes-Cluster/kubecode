import { type ReactNode, useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, TaskActivity as TaskActivityStep, TaskDetail } from '../api'
import { useInspectorServices } from '../app/inspector/inspectorContext'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { useDefaultChannel } from '../channel/useChannel'
import { ResearchExportPanel } from '../research/ResearchExportPanel'
import { ResearchImportPanel } from '../research/ResearchImportPanel'
import { ResearchRoundsPanel } from '../research/ResearchRoundsPanel'
import { ResearchThreadsPanel } from '../research/ResearchThreadsPanel'
import { useRefreshTick, useResearchImports, type ResearchBundle } from '../research/useResearch'
import { ReaderEmpty, ReaderLoading, ReaderNotice } from '../resources/ReaderStates'
import { TaskDisclosure } from './TaskDisclosure'
import { taskTime } from './taskLabels'
import { useShowInGeneral } from './taskNavigation'

export type TaskActivityProps = {
  detail: TaskDetail
  projectId: string
  /** The research record behind the Task, for its execution and linked records. */
  bundle?: ResearchBundle | null
  onBundleChanged?: () => void
}

const RECENT = 5
const EXCERPT_CHARS = 140

/**
 * What happened to a Task (ADR 0230 §3): each step in words, newest first,
 * with the researcher's own words where they authorized it and the General
 * message that carried it; what was said about it in General lately; and,
 * when asked, its execution and linked records. Nothing here starts work.
 */
export function TaskActivity({ bundle = null, detail, onBundleChanged, projectId }: TaskActivityProps) {
  const { locale, t } = useInspectorServices()
  const showInGeneral = useShowInGeneral(detail.id)
  const steps = [...(detail.timeline ?? [])].reverse()
  return (
    <div className="flex min-w-0 flex-col gap-4 pt-2">
      <h4 className="text-sm font-semibold">{t('kubecode.task.activity.history')}</h4>
      {steps.length === 0
        ? <ReaderEmpty>{t('kubecode.task.activity.empty')}</ReaderEmpty>
        : (
          // Each step as an official Item in an ordered list, newest first.
          <ol aria-label={t('kubecode.task.activity.history')} className="flex flex-col gap-2">
            {steps.map((step, index) => (
              <li key={`${step.kind}-${step.at}-${index}`}>
                <Item size="sm" variant="outline">
                  <ItemContent className="gap-1">
                    <ItemTitle className="font-normal [overflow-wrap:anywhere]">{sentence(t, step)}</ItemTitle>
                    <ItemDescription>{taskTime(step.at, locale)}</ItemDescription>
                    {step.excerpt && <q className="text-sm [overflow-wrap:anywhere]">{step.excerpt}</q>}
                  </ItemContent>
                  {step.message_id && (
                    <ItemActions>
                      <Button size="xs" variant="ghost" onClick={() => showInGeneral(step.message_id as string)}>
                        {t('kubecode.task.showInGeneral')}
                      </Button>
                    </ItemActions>
                  )}
                </Item>
              </li>
            ))}
          </ol>
        )}
      <RecentInGeneral projectId={projectId} taskId={detail.id} onShow={showInGeneral} />
      <ExecutionRecords bundle={bundle} detail={detail} onBundleChanged={onBundleChanged} />
      <LinkedRecords bundle={bundle} projectId={projectId} taskId={detail.id} onBundleChanged={onBundleChanged} />
    </div>
  )
}

function sentence(t: Translator, step: TaskActivityStep): string {
  const actor = step.member?.name
    ?? (step.actor === 'researcher' ? t('kubecode.task.activity.you') : t('kubecode.task.activity.someone'))
  const revision = step.brief_revision ?? ''
  switch (step.kind) {
    case 'proposed': return t('kubecode.task.activity.proposed', { actor, revision })
    case 'revised': return t('kubecode.task.activity.revised', { actor, revision })
    case 'admitted': return t('kubecode.task.activity.admitted')
    case 'revision_approved': return t('kubecode.task.activity.revision_approved', { revision })
    case 'execution_authorized': return t('kubecode.task.activity.execution_authorized')
    case 'review_requested': return t('kubecode.task.activity.review_requested', { actor })
    case 'review_returned': return t('kubecode.task.activity.review_returned')
    case 'review_accepted': return t('kubecode.task.activity.review_accepted')
    case 'archived': return t('kubecode.task.activity.archived')
    case 'restored': return t('kubecode.task.activity.restored')
  }
}

const excerptOf = (body: string) => {
  const line = body.split('\n').find((text) => text.trim() !== '')?.trim() ?? ''
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line
}

/** The newest messages about the Task in the one General conversation (ADR 0223 §3). */
function RecentInGeneral({ onShow, projectId, taskId }: {
  projectId: string
  taskId: string
  onShow: (messageId: string) => void
}) {
  const { api, connectionState, events, locale, t } = useInspectorServices()
  const { channel, retry: retryChannel, status: channelStatus } = useDefaultChannel(api, projectId)
  const channelId = channel?.id ?? null
  const matches = useCallback((event: { kind: string; project_id: string | null }) => (
    event.project_id === projectId && event.kind === 'channel_updated'
  ), [projectId])
  const tick = useRefreshTick(events, connectionState, matches)
  const [attempt, setAttempt] = useState(0)
  const [messages, setMessages] = useState<
    { key: string; list: ChannelMessage[]; failed?: never } | { key: string; failed: true; list?: never } | null
  >(null)
  const key = `${projectId}|${channelId ?? ''}|${taskId}`

  useEffect(() => {
    if (!channelId || typeof api.listChannelMessages !== 'function') return
    let live = true
    api.listChannelMessages(projectId, channelId, { taskId, limit: RECENT }).then(
      (page) => { if (live) setMessages({ key, list: page.messages }) },
      () => { if (live) setMessages({ key, failed: true }) },
    )
    return () => { live = false }
  }, [api, attempt, channelId, key, projectId, taskId, tick])

  const current = messages?.key === key ? messages : null
  // A list that loaded once stays while it is read again; a failure is said, never shown as "nothing".
  const failed = channelStatus === 'error' || Boolean(current?.failed)
  const list = current?.list ? [...current.list].reverse() : null
  const retry = () => {
    setMessages(null)
    if (channelStatus === 'error') retryChannel()
    else setAttempt((value) => value + 1)
  }
  return (
    <section aria-label={t('kubecode.task.activity.inGeneral')} className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{t('kubecode.task.activity.inGeneral')}</h4>
      {failed ? (
        <ReaderNotice action={<Button size="xs" variant="outline" onClick={retry}>{t('kubecode.retry')}</Button>} failed>
          {t('kubecode.task.activity.inGeneralFailed')}
        </ReaderNotice>
      ) : list === null ? (
        <ReaderLoading>{t('kubecode.task.activity.inGeneralLoading')}</ReaderLoading>
      ) : list.length === 0
        ? <ReaderEmpty>{t('kubecode.task.activity.inGeneralEmpty')}</ReaderEmpty>
        : (
          <ItemGroup className="gap-1" role="list">
            {list.map((message) => (
              <div key={message.id} role="listitem">
                {/* One message, one official Item that is itself the button showing it in General. */}
                <Item asChild className="w-full text-left" size="sm">
                  <button type="button" onClick={() => onShow(message.id)}>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="block w-full truncate font-normal">{excerptOf(message.body)}</ItemTitle>
                      <ItemDescription>{taskTime(message.created_at, locale)}</ItemDescription>
                    </ItemContent>
                  </button>
                </Item>
              </div>
            ))}
          </ItemGroup>
        )}
    </section>
  )
}

/**
 * A record section folded by the official Collapsible (#259). Its body is
 * read only once opened, so a Task's details never load every round up front,
 * and it stays mounted once read.
 */
function RecordsDisclosure({ children, label }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setOpened(true)
      }}
    >
      <TaskDisclosure>{label}</TaskDisclosure>
      <CollapsibleContent className="flex flex-col gap-2 pt-2" forceMount hidden={!open}>
        {opened && children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ExecutionRecords({ bundle, detail, onBundleChanged }: {
  bundle: ResearchBundle | null
  detail: TaskDetail
  onBundleChanged?: () => void
}) {
  const services = useInspectorServices()
  const { openSession } = useWorkspaceNavigation()
  const { t } = services
  const sessions = detail.internal_work.filter((work) => work.conversation_id)
  return (
    <RecordsDisclosure label={t('kubecode.task.activity.execution')}>
          {sessions.length > 0 && (
            <ItemGroup className="gap-1" role="list">
              {sessions.map((work) => (
                <Item key={work.id} role="listitem" size="sm" variant="outline">
                  <ItemContent>
                    <ItemTitle className="[overflow-wrap:anywhere]">{work.title}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                  <Button
                    aria-label={t('kubecode.task.openSessionOf', { title: work.title })}
                   
                    size="xs"
                    variant="outline"
                    onClick={() => openSession(work.conversation_id as string)}
                  >
                    {t('kubecode.task.openSession')}
                  </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
          {bundle && (
            <ResearchRoundsPanel
              agents={services.agents}
              api={services.api}
              connectionState={services.connectionState}
              detail={bundle.detail}
              events={services.events}
              findings={bundle.findings}
              rounds={bundle.rounds}
              startsRounds={false}
              t={t}
              teams={services.teams}
              onChanged={() => onBundleChanged?.()}
              onOpenSession={openSession}
            />
          )}
    </RecordsDisclosure>
  )
}

function LinkedRecords({ bundle, onBundleChanged, projectId, taskId }: {
  bundle: ResearchBundle | null
  projectId: string
  taskId: string
  onBundleChanged?: () => void
}) {
  const { api, connectionState, events, t } = useInspectorServices()
  const { openPlace } = useWorkspaceNavigation()
  return (
    <RecordsDisclosure label={t('kubecode.task.activity.records')}>
          <ResearchThreadsPanel
            api={api}
            connectionState={connectionState}
            events={events}
            projectId={projectId}
            researchId={taskId}
            t={t}
            // A Thread opens in General with nothing over it and no Task filter.
            onOpenThread={(threadId) => openPlace({ view: 'general', thread: threadId, filter: null }, { inspector: 'closed' })}
          />
          {bundle && <Imports bundle={bundle} projectId={projectId} taskId={taskId} onBundleChanged={onBundleChanged} />}
    </RecordsDisclosure>
  )
}

function Imports({ bundle, onBundleChanged, projectId, taskId }: {
  bundle: ResearchBundle
  projectId: string
  taskId: string
  onBundleChanged?: () => void
}) {
  const { api, connectionState, events, t } = useInspectorServices()
  const imports = useResearchImports(api, projectId, taskId, events, connectionState)
  return (
    <>
      <ResearchImportPanel
        api={api}
        detail={bundle.detail}
        imports={imports.imports}
        importsStatus={imports.status}
        t={t}
        onChanged={() => {
          onBundleChanged?.()
          imports.reload()
        }}
      />
      <ResearchExportPanel api={api} detail={bundle.detail} t={t} />
    </>
  )
}
