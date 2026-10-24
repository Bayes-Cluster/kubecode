import { useEffect, useState } from 'react'
import { Archive, CircleAlert, Info } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconButton } from '@/components/workspace/IconButton'
import type { ViewHeaderProps } from '@/components/workspace/ViewHeader'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  Conversation,
  KubecodeApi,
  TeamSnapshot,
  WorkspaceEvent,
} from '../api'
import { ApiError } from '../api'
import { stageLabel } from '../tasks/taskLabels'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { ResearchBriefPanel } from './ResearchBriefPanel'
import { ResearchDiscussionPanel } from './ResearchDiscussionPanel'
import { ResearchExportPanel } from './ResearchExportPanel'
import { ResearchImportPanel } from './ResearchImportPanel'
import { ResearchFindingsPanel } from './ResearchFindingsPanel'
import { ResearchRoundsPanel } from './ResearchRoundsPanel'
import { ResearchThreadsPanel } from './ResearchThreadsPanel'
import { useAction } from './useAction'
import { useResearchBundle, useResearchImports } from './useResearch'
import { ReaderLoading, ReaderNotice } from '../resources/ReaderStates'
import { statusToneVariant } from '../statusTone'

export type ResearchWorkspaceProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  conversations: Conversation[]
  events: WorkspaceEvent[]
  /** In the inspector: its Back, drawn in this header (ADR 0227 shape). */
  back?: ViewHeaderProps['back']
  /** In the inspector: its Close, drawn in this header (ADR 0227 shape). */
  close?: ViewHeaderProps['close']
  /**
   * Opens the Task this question is, when its record says it is one (admitted,
   * on the board or archived): then its stage is its state, it is finished by
   * its review, and it is opened as a Task (ADR 0230 §3).
   */
  onOpenTask?: () => void
  /** Whether rounds can be started here; a Task's detail leaves that to the General Agent. */
  startsRounds?: boolean
  /** The loaded title, for the inspector's "Back to …" one level up. */
  onTitle?: (title: string) => void
  onConversationCreated: (conversation: Conversation) => void
  onOpenSession: (conversationId: string) => void
  /** Opens a Workspace-conversation Thread; omitted when there is no conversation surface. */
  onOpenThread?: (threadId: string) => void
  /** Opens the one work board filtered to this question. */
  onOpenBoard?: (filter: { research_id: string }) => void
  projectId: string
  researchId: string
  t: Translator
  teams: TeamSnapshot[]
}

type TabId = 'brief' | 'discussion' | 'findings' | 'work'

/**
 * One question from discussion through execution and findings. Sessions and
 * Teams stay the place where work happens; this surface records the question,
 * what each round consumed, and what came back. Nothing here starts an Agent
 * except the explicit round action.
 */
export function ResearchWorkspace({
  agents,
  api,
  connectionState,
  conversations,
  events,
  back,
  close,
  startsRounds = true,
  onConversationCreated,
  onOpenSession,
  onOpenBoard,
  onOpenTask,
  onOpenThread,
  onTitle,
  projectId,
  researchId,
  t,
  teams,
}: ResearchWorkspaceProps) {
  const { bundle, errorCode, reload, status } = useResearchBundle(
    api,
    projectId,
    researchId,
    events,
    connectionState,
  )
  const importsState = useResearchImports(api, projectId, researchId, events, connectionState)
  const [tab, setTab] = useState<TabId>('brief')
  const state = useAction(t)
  const title = bundle?.detail.brief.title ?? null

  useEffect(() => {
    if (title) onTitle?.(title)
  }, [onTitle, title])

  const backControl = back ? (
    <IconButton
      icon={<Icon role="navigation" source={WORKSPACE_COMMAND_ICONS.back.Icon} />}
      label={back.label}
      size="md"
      onClick={back.onBack}
    />
  ) : null
  const closeControl = close ? (
    <IconButton
      icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.close.Icon} />}
      label={close.label}
      size="md"
      onClick={close.onClose}
    />
  ) : null

  if (!bundle) {
    return (
      <section className="kubecode-research-workspace" aria-busy={status === 'loading'}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          {backControl}
          {closeControl}
        </header>
        {status === 'loading' && <ReaderLoading>{t('kubecode.research.loading')}</ReaderLoading>}
        {status === 'error' && (
          <ReaderNotice
            action={errorCode !== 'research_not_found' && (
              <Button size="sm" variant="outline" onClick={reload}>{t('kubecode.retry')}</Button>
            )}
            failed
          >
            {errorCode === 'research_not_found' ? t('kubecode.research.error.notFound') : t('kubecode.research.loadFailed')}
          </ReaderNotice>
        )}
      </section>
    )
  }

  const { detail } = bundle
  // Whether the question is a Task comes from its own record, never from a capped board list.
  const task = detail.task_stage && onOpenTask ? { stage: detail.task_stage, onOpen: onOpenTask } : null
  const pendingDecisions = bundle.proposals.filter((proposal) => !proposal.review).length
    + bundle.outcomes.filter((outcome) => outcome.status === 'pending').length
  const command = (action: 'archive' | 'restore' | 'resolve' | 'reopen') => void state.run(async () => {
    try {
      await api.setResearchState(projectId, researchId, action)
    } catch (cause) {
      // An admitted Task's status is its lifecycle's (ADR 0230 §1).
      if (cause instanceof ApiError && cause.code === 'task_owned') throw new Error(t('kubecode.task.ownedStatus'))
      // An archive a Task's rule refused says why in words (ADR 0230 §2).
      if (cause instanceof ApiError && cause.code === 'task_active') throw new Error(archiveBlockedText(t, cause.reason))
      throw cause
    }
    reload()
  })

  return (
    <section className="kubecode-research-workspace" aria-label={detail.brief.title}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {backControl}
          <h2 className="my-1 text-lg font-semibold [overflow-wrap:anywhere]">{detail.brief.title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {task ? (
              <Badge variant={statusToneVariant(task.stage === 'done' ? 'ok' : 'info')}>{stageLabel(t, task.stage)}</Badge>
            ) : (
              <Badge variant={statusToneVariant(detail.status === 'open' ? 'ok' : 'muted')}>
                {detail.status === 'open' ? t('kubecode.research.status.open') : t('kubecode.research.status.resolved')}
              </Badge>
            )}
            {detail.archived && (
              <Badge variant="secondary">{t('kubecode.research.status.archived')}</Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {t('kubecode.research.revision', { revision: detail.revision })}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {task ? (
            <Button size="sm" variant="outline" onClick={task.onOpen}>{t('kubecode.task.openTask')}</Button>
          ) : (
            <>
              {detail.status === 'open'
                ? <Button disabled={state.busy || detail.archived} size="sm" variant="outline" onClick={() => command('resolve')}>{t('kubecode.research.resolve')}</Button>
                : <Button disabled={state.busy || detail.archived} size="sm" variant="outline" onClick={() => command('reopen')}>{t('kubecode.research.reopen')}</Button>}
              {detail.archived
                ? <Button disabled={state.busy} size="sm" variant="outline" onClick={() => command('restore')}>{t('kubecode.research.restore')}</Button>
                : <Button disabled={state.busy} size="sm" variant="ghost" onClick={() => command('archive')}>{t('kubecode.research.archive')}</Button>}
            </>
          )}
          {closeControl}
        </div>
      </header>
      <div className="mt-2 flex flex-col gap-2 empty:hidden">
        {state.error && <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>}
        {task && <Alert role="status"><Info /><AlertDescription>{t('kubecode.task.isTask')}</AlertDescription></Alert>}
        {detail.archived && <Alert role="status"><Archive /><AlertDescription>{t('kubecode.research.archivedNotice')}</AlertDescription></Alert>}
        {pendingDecisions > 0 && (
          <Alert role="status">
            <CircleAlert />
            <AlertDescription>
              <Button className="h-auto p-0" size="sm" variant="link" onClick={() => setTab('findings')}>
                {t('kubecode.research.pendingDecisions', { count: pendingDecisions })}
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)} className="mt-2">
        <TabsList variant="line">
          <TabsTrigger value="brief">{t('kubecode.research.tab.brief')}</TabsTrigger>
          <TabsTrigger value="discussion">{t('kubecode.research.tab.discussion')}</TabsTrigger>
          <TabsTrigger value="findings">
            {t('kubecode.research.tab.findings')}
            {pendingDecisions > 0 ? ` (${pendingDecisions})` : ''}
          </TabsTrigger>
          <TabsTrigger value="work">{t('kubecode.research.tab.work')}</TabsTrigger>
        </TabsList>
        <TabsContent forceMount value="brief" hidden={tab !== 'brief'}>
          <ResearchBriefPanel api={api} detail={detail} onChanged={reload} t={t} />
        </TabsContent>
        <TabsContent forceMount value="discussion" hidden={tab !== 'discussion'}>
          <ResearchDiscussionPanel
            agents={agents}
            api={api}
            conversations={conversations}
            detail={detail}
            entries={bundle.entries}
            onChanged={reload}
            onConversationCreated={onConversationCreated}
            onOpenSession={onOpenSession}
            t={t}
          />
          {onOpenThread && (
            <ResearchThreadsPanel
              api={api}
              connectionState={connectionState}
              events={events}
              onOpenThread={onOpenThread}
              projectId={projectId}
              researchId={researchId}
              t={t}
            />
          )}
          <ResearchImportPanel
            api={api}
            detail={detail}
            imports={importsState.imports}
            importsStatus={importsState.status}
            onChanged={() => {
              reload()
              importsState.reload()
            }}
            t={t}
          />
          <ResearchExportPanel api={api} detail={detail} t={t} />
        </TabsContent>
        <TabsContent forceMount value="findings" hidden={tab !== 'findings'}>
          <ResearchFindingsPanel
            api={api}
            detail={detail}
            findings={bundle.findings}
            onChanged={reload}
            outcomes={bundle.outcomes}
            proposals={bundle.proposals}
            rounds={bundle.rounds}
            t={t}
          />
        </TabsContent>
        <TabsContent forceMount value="work" hidden={tab !== 'work'}>
          {onOpenBoard && (
            <div className="pt-2">
              <Button size="xs" variant="outline" onClick={() => onOpenBoard({ research_id: researchId })}>
                {t('kubecode.work.openBoard')}
              </Button>
            </div>
          )}
          <ResearchRoundsPanel
            agents={agents}
            api={api}
            connectionState={connectionState}
            detail={detail}
            events={events}
            findings={bundle.findings}
            imports={importsState.imports}
            onChanged={reload}
            onOpenSession={onOpenSession}
            rounds={bundle.rounds}
            startsRounds={startsRounds}
            t={t}
            teams={teams}
          />
        </TabsContent>
      </Tabs>
    </section>
  )
}

function archiveBlockedText(t: Translator, reason: string | null): string {
  switch (reason) {
    case 'work_active': return t('kubecode.task.archiveBlocked.work_active')
    case 'archived': return t('kubecode.task.archiveBlocked.archived')
    default: return t('kubecode.task.archiveBlocked.under_review')
  }
}
