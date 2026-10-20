import { useCallback, useEffect, useState, type SyntheticEvent } from 'react'

import { Button } from '@/components/ui/button'
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
    <div className="kubecode-task-activity">
      <h4>{t('kubecode.task.activity.history')}</h4>
      {steps.length === 0
        ? <p className="kubecode-research-muted">{t('kubecode.task.activity.empty')}</p>
        : (
          <ol aria-label={t('kubecode.task.activity.history')} className="kubecode-task-timeline">
            {steps.map((step, index) => (
              <li key={`${step.kind}-${step.at}-${index}`}>
                <span>{sentence(t, step)}</span>
                <small className="kubecode-research-muted">{taskTime(step.at, locale)}</small>
                {step.excerpt && <q>{step.excerpt}</q>}
                {step.message_id && (
                  <Button size="xs" variant="ghost" onClick={() => showInGeneral(step.message_id as string)}>
                    {t('kubecode.task.showInGeneral')}
                  </Button>
                )}
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
    <section aria-label={t('kubecode.task.activity.inGeneral')} className="kubecode-task-recent">
      <h4>{t('kubecode.task.activity.inGeneral')}</h4>
      {failed ? (
        <p className="kubecode-research-error" role="alert">
          {t('kubecode.task.activity.inGeneralFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={retry}>{t('kubecode.retry')}</Button>
        </p>
      ) : list === null ? (
        <p className="kubecode-research-muted" role="status">{t('kubecode.task.activity.inGeneralLoading')}</p>
      ) : list.length === 0
        ? <p className="kubecode-research-muted">{t('kubecode.task.activity.inGeneralEmpty')}</p>
        : (
          <ul>
            {list.map((message) => (
              <li key={message.id}>
                <Button className="kubecode-task-recent-message" size="xs" variant="ghost" onClick={() => onShow(message.id)}>
                  {excerptOf(message.body)}
                </Button>
                <small className="kubecode-research-muted">{taskTime(message.created_at, locale)}</small>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/** Shown only once opened, so a Task's details never load every round up front. */
function useOpened(): [boolean, (event: SyntheticEvent<HTMLDetailsElement>) => void] {
  const [opened, setOpened] = useState(false)
  return [opened, (event) => {
    if (event.currentTarget.open) setOpened(true)
  }]
}

function ExecutionRecords({ bundle, detail, onBundleChanged }: {
  bundle: ResearchBundle | null
  detail: TaskDetail
  onBundleChanged?: () => void
}) {
  const services = useInspectorServices()
  const { openSession } = useWorkspaceNavigation()
  const { t } = services
  const [opened, onToggle] = useOpened()
  const sessions = detail.internal_work.filter((work) => work.conversation_id)
  return (
    <details className="kubecode-task-records" onToggle={onToggle}>
      <summary>{t('kubecode.task.activity.execution')}</summary>
      {opened && (
        <>
          {sessions.length > 0 && (
            <ul className="kubecode-task-work">
              {sessions.map((work) => (
                <li key={work.id}>
                  <span>{work.title}</span>
                  <Button
                    aria-label={t('kubecode.task.openSessionOf', { title: work.title })}
                    size="xs"
                    variant="outline"
                    onClick={() => openSession(work.conversation_id as string)}
                  >
                    {t('kubecode.task.openSession')}
                  </Button>
                </li>
              ))}
            </ul>
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
        </>
      )}
    </details>
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
  const [opened, onToggle] = useOpened()
  return (
    <details className="kubecode-task-records" onToggle={onToggle}>
      <summary>{t('kubecode.task.activity.records')}</summary>
      {opened && (
        <>
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
        </>
      )}
    </details>
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
