import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  Conversation,
  KubecodeApi,
  TeamSnapshot,
  WorkspaceEvent,
} from '../api'
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

export type ResearchWorkspaceProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  conversations: Conversation[]
  events: WorkspaceEvent[]
  onClose: () => void
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
  onClose,
  onConversationCreated,
  onOpenSession,
  onOpenBoard,
  onOpenThread,
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

  if (!bundle) {
    return (
      <section className="kubecode-research-workspace" aria-busy={status === 'loading'}>
        <header className="kubecode-research-header">
          <Button size="sm" variant="ghost" onClick={onClose}>{t('kubecode.research.back')}</Button>
        </header>
        {status === 'loading' && <p className="kubecode-empty-small" role="status">{t('kubecode.research.loading')}</p>}
        {status === 'error' && (
          <div className="kubecode-empty-small" role="alert">
            <p>{errorCode === 'research_not_found' ? t('kubecode.research.error.notFound') : t('kubecode.research.loadFailed')}</p>
            {errorCode !== 'research_not_found' && (
              <Button size="sm" variant="outline" onClick={reload}>{t('kubecode.retry')}</Button>
            )}
          </div>
        )}
      </section>
    )
  }

  const { detail } = bundle
  const pendingDecisions = bundle.proposals.filter((proposal) => !proposal.review).length
    + bundle.outcomes.filter((outcome) => outcome.status === 'pending').length
  const command = (action: 'archive' | 'restore' | 'resolve' | 'reopen') => void state.run(async () => {
    await api.setResearchState(projectId, researchId, action)
    reload()
  })

  return (
    <section className="kubecode-research-workspace" aria-label={detail.brief.title}>
      <header className="kubecode-research-header">
        <div>
          <Button size="xs" variant="ghost" onClick={onClose}>{t('kubecode.research.back')}</Button>
          <h2>{detail.brief.title}</h2>
          <div className="kubecode-research-header-meta">
            <StatusBadge tone={detail.status === 'open' ? 'ok' : 'muted'}>
              {detail.status === 'open' ? t('kubecode.research.status.open') : t('kubecode.research.status.resolved')}
            </StatusBadge>
            {detail.archived && (
              <StatusBadge tone="muted">{t('kubecode.research.status.archived')}</StatusBadge>
            )}
            <span className="kubecode-research-muted">
              {t('kubecode.research.revision', { revision: detail.revision })}
            </span>
          </div>
        </div>
        <div className="kubecode-research-header-actions">
          {detail.status === 'open'
            ? <Button disabled={state.busy || detail.archived} size="sm" variant="outline" onClick={() => command('resolve')}>{t('kubecode.research.resolve')}</Button>
            : <Button disabled={state.busy || detail.archived} size="sm" variant="outline" onClick={() => command('reopen')}>{t('kubecode.research.reopen')}</Button>}
          {detail.archived
            ? <Button disabled={state.busy} size="sm" variant="outline" onClick={() => command('restore')}>{t('kubecode.research.restore')}</Button>
            : <Button disabled={state.busy} size="sm" variant="ghost" onClick={() => command('archive')}>{t('kubecode.research.archive')}</Button>}
        </div>
      </header>
      {state.error && <p className="kubecode-research-error" role="alert">{state.error}</p>}
      {detail.archived && <p className="kubecode-research-notice" role="status">{t('kubecode.research.archivedNotice')}</p>}
      {pendingDecisions > 0 && (
        <p className="kubecode-research-notice" role="status">
          <button type="button" onClick={() => setTab('findings')}>
            {t('kubecode.research.pendingDecisions', { count: pendingDecisions })}
          </button>
        </p>
      )}
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)} className="kubecode-research-tabs">
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
            <p className="kubecode-research-muted">
              <Button size="xs" variant="outline" onClick={() => onOpenBoard({ research_id: researchId })}>
                {t('kubecode.work.openBoard')}
              </Button>
            </p>
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
            t={t}
            teams={teams}
          />
        </TabsContent>
      </Tabs>
    </section>
  )
}
