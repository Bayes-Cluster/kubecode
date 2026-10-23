import { useMemo, useRef, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  AgentId,
  Conversation,
  KubecodeApi,
  ResearchDetail,
  ResearchEntry,
} from '../api'
import { newClientMessageId } from '../session/sessionModel'
import { agentLabel, authorLabel, entryKindLabel } from './researchLabels'
import { ResearchPanel, ResearchSection } from './ResearchLayout'
import { AvailabilityBadge } from './SourceBadge'
import { useAction } from './useAction'

export function ResearchDiscussionPanel({
  agents,
  api,
  conversations,
  detail,
  entries,
  onChanged,
  onConversationCreated,
  onOpenSession,
  t,
}: {
  agents: AgentDescriptor[]
  api: KubecodeApi
  conversations: Conversation[]
  detail: ResearchDetail
  entries: ResearchEntry[]
  onChanged: () => void
  onConversationCreated: (conversation: Conversation) => void
  onOpenSession: (conversationId: string) => void
  t: Translator
}) {
  const sessions = detail.links.filter((link) => link.kind === 'session')
  const linkedIds = useMemo(() => new Set(detail.links.map((link) => link.ref_id)), [detail.links])
  const linkable = conversations.filter((item) => (
    item.project_id === detail.project_id
    && !item.archived
    && !item.team_id
    && item.relationship !== 'team_member'
    && item.relationship !== 'subagent'
    && !linkedIds.has(item.id)
  ))
  const available = agents.filter((agent) => agent.available)
  const [agentId, setAgentId] = useState<AgentId | ''>('')
  const [linkId, setLinkId] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<'note' | 'decision'>('note')
  const entryKey = useRef(newClientMessageId())
  const discussion = useAction(t)
  const entry = useAction(t)
  const selectedAgent = agentId || available[0]?.id || ''

  const startDiscussion = async () => {
    if (!selectedAgent) return
    await discussion.run(async () => {
      const created = await api.createConversation(
        detail.project_id,
        selectedAgent,
        detail.brief.title,
      )
      // Linked before the shell is told about it: announcing a Session
      // navigates away, which would hide a failed link.
      await api.linkResearch(detail.project_id, detail.id, 'session', created.id, 'discussion')
      onConversationCreated(created)
      onChanged()
      onOpenSession(created.id)
    })
  }
  const linkExisting = async () => {
    if (!linkId) return
    const linked = await discussion.run(() => (
      api.linkResearch(detail.project_id, detail.id, 'session', linkId, 'discussion')
    ))
    if (linked) {
      setLinkId('')
      onChanged()
    }
  }
  const unlink = (refId: string) => void discussion.run(async () => {
    await api.unlinkResearch(detail.project_id, detail.id, 'session', refId)
    onChanged()
  })
  const addEntry = async () => {
    const text = body.trim()
    if (!text) return
    const added = await entry.run(() => (
      api.addResearchEntry(detail.project_id, detail.id, kind, text, entryKey.current)
    ))
    if (added) {
      entryKey.current = newClientMessageId()
      setBody('')
      onChanged()
    }
  }

  return (
    <ResearchPanel>
      <ResearchSection label={t('kubecode.research.discussionSessions')}>
        {sessions.length === 0 && (
          <Empty className="items-start p-0 text-left">
            <EmptyDescription>{t('kubecode.research.noDiscussionSessions')}</EmptyDescription>
          </Empty>
        )}
        {sessions.length > 0 && (
          <ItemGroup>
            {sessions.map((link) => (
              <Item key={link.ref_id} size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle className="[overflow-wrap:anywhere]">
                    {link.title || t('kubecode.untitledSession')}
                  </ItemTitle>
                  {(link.agent_id || link.availability !== 'available' || link.state === 'archived') && (
                    <ItemDescription className="flex flex-wrap items-center gap-2">
                      {link.agent_id && <span>{agentLabel(link.agent_id)}</span>}
                      {link.availability !== 'available' && <AvailabilityBadge availability={link.availability} t={t} />}
                      {link.state === 'archived' && (
                        <StatusBadge tone="muted">{t('kubecode.research.sessionArchived')}</StatusBadge>
                      )}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={`${t('kubecode.research.openSession')}: ${link.title || t('kubecode.untitledSession')}`}
                    disabled={link.availability === 'removed'}
                    size="xs"
                    variant="outline"
                    onClick={() => onOpenSession(link.ref_id)}
                  >
                    {t('kubecode.research.openSession')}
                  </Button>
                  <Button
                    aria-label={`${t('kubecode.research.unlink')}: ${link.title || t('kubecode.untitledSession')}`}
                    disabled={discussion.busy}
                    size="xs"
                    variant="ghost"
                    onClick={() => unlink(link.ref_id)}
                  >
                    {t('kubecode.research.unlink')}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        {!detail.archived && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selectedAgent} onValueChange={(value) => setAgentId(value as AgentId)}>
              <SelectTrigger aria-label={t('kubecode.agent')} className="min-w-[140px] flex-1 sm:flex-none" disabled={available.length === 0}>
                <SelectValue placeholder={t('kubecode.research.noAgents')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {available.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>{agentLabel(agent.id)}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              disabled={!selectedAgent || discussion.busy}
              size="sm"
              variant="outline"
              onClick={() => void startDiscussion()}
            >
              {t('kubecode.research.startDiscussion')}
            </Button>
          </div>
        )}
        {!detail.archived && linkable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={linkId} onValueChange={setLinkId}>
              <SelectTrigger aria-label={t('kubecode.research.linkSession')} className="min-w-[140px] flex-1 sm:flex-none">
                <SelectValue placeholder={t('kubecode.research.linkSession')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {linkable.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title || t('kubecode.untitledSession')}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button disabled={!linkId || discussion.busy} size="sm" variant="outline" onClick={() => void linkExisting()}>
              {t('kubecode.research.link')}
            </Button>
          </div>
        )}
        {discussion.error && <Alert variant="destructive"><AlertDescription>{discussion.error}</AlertDescription></Alert>}
      </ResearchSection>

      <ResearchSection label={t('kubecode.research.log')}>
        {entries.length === 0 && (
          <Empty className="items-start p-0 text-left">
            <EmptyDescription>{t('kubecode.research.noEntries')}</EmptyDescription>
          </Empty>
        )}
        {entries.length > 0 && (
          <ItemGroup className="gap-2">
            {entries.map((item) => (
              <Item data-kind={item.kind} key={item.id} size="sm" variant={item.kind === 'decision' ? 'outline' : 'muted'}>
                <ItemContent>
                  <ItemDescription className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={item.kind === 'decision' ? 'ok' : 'muted'}>
                      {entryKindLabel(t, item.kind)}
                    </StatusBadge>
                    <span>
                      {authorLabel(t, item.author_kind)} · {t('kubecode.research.revisionShort', { revision: item.brief_revision })}
                    </span>
                  </ItemDescription>
                  <p className="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{item.body}</p>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
        {!detail.archived && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void addEntry()
            }}
          >
            <Textarea
              aria-label={t('kubecode.research.entryBody')}
              rows={3}
              value={body}
              maxLength={8192}
              placeholder={t('kubecode.research.entryPlaceholder')}
              onChange={(event) => {
                entryKey.current = newClientMessageId()
                setBody(event.target.value)
              }}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Select
                value={kind}
                onValueChange={(value) => {
                  entryKey.current = newClientMessageId()
                  setKind(value as 'note' | 'decision')
                }}
              >
                <SelectTrigger aria-label={t('kubecode.research.entryKind')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="note">{t('kubecode.research.entryKind.note')}</SelectItem>
                    <SelectItem value="decision">{t('kubecode.research.entryKind.decision')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button aria-busy={entry.busy} disabled={!body.trim() || entry.busy} size="sm" type="submit">
                {t('kubecode.research.addEntry')}
              </Button>
            </div>
            {entry.error && <Alert variant="destructive"><AlertDescription>{entry.error}</AlertDescription></Alert>}
          </form>
        )}
      </ResearchSection>
    </ResearchPanel>
  )
}
