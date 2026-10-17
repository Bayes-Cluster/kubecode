import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
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
    <div className="kubecode-research-panel">
      <section className="kubecode-research-section">
        <h3>{t('kubecode.research.discussionSessions')}</h3>
        {sessions.length === 0 && (
          <p className="kubecode-research-muted">{t('kubecode.research.noDiscussionSessions')}</p>
        )}
        <ul className="kubecode-research-list">
          {sessions.map((link) => (
            <li key={link.ref_id}>
              <span className="kubecode-research-item-title">
                {link.title || t('kubecode.untitledSession')}
              </span>
              {link.agent_id && <span className="kubecode-research-muted">{agentLabel(link.agent_id)}</span>}
              {link.availability !== 'available' && <AvailabilityBadge availability={link.availability} t={t} />}
              {link.state === 'archived' && (
                <span className="kubecode-research-badge" data-tone="muted">{t('kubecode.research.sessionArchived')}</span>
              )}
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
            </li>
          ))}
        </ul>
        {!detail.archived && (
          <div className="kubecode-research-row">
            <Select value={selectedAgent} onValueChange={(value) => setAgentId(value as AgentId)}>
              <SelectTrigger aria-label={t('kubecode.agent')} disabled={available.length === 0}>
                <SelectValue placeholder={t('kubecode.research.noAgents')} />
              </SelectTrigger>
              <SelectContent>
                {available.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agentLabel(agent.id)}</SelectItem>
                ))}
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
          <div className="kubecode-research-row">
            <Select value={linkId} onValueChange={setLinkId}>
              <SelectTrigger aria-label={t('kubecode.research.linkSession')}>
                <SelectValue placeholder={t('kubecode.research.linkSession')} />
              </SelectTrigger>
              <SelectContent>
                {linkable.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title || t('kubecode.untitledSession')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button disabled={!linkId || discussion.busy} size="sm" variant="outline" onClick={() => void linkExisting()}>
              {t('kubecode.research.link')}
            </Button>
          </div>
        )}
        {discussion.error && <p className="kubecode-research-error" role="alert">{discussion.error}</p>}
      </section>

      <section className="kubecode-research-section">
        <h3>{t('kubecode.research.log')}</h3>
        {entries.length === 0 && <p className="kubecode-research-muted">{t('kubecode.research.noEntries')}</p>}
        <ol className="kubecode-research-log">
          {entries.map((item) => (
            <li key={item.id} data-kind={item.kind}>
              <header>
                <span className="kubecode-research-badge" data-tone={item.kind === 'decision' ? 'ok' : 'muted'}>
                  {entryKindLabel(t, item.kind)}
                </span>
                <span className="kubecode-research-muted">
                  {authorLabel(t, item.author_kind)} · {t('kubecode.research.revisionShort', { revision: item.brief_revision })}
                </span>
              </header>
              <p>{item.body}</p>
            </li>
          ))}
        </ol>
        {!detail.archived && (
          <form
            className="kubecode-research-form"
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
            <div className="kubecode-research-row">
              <Select
                value={kind}
                onValueChange={(value) => {
                  entryKey.current = newClientMessageId()
                  setKind(value as 'note' | 'decision')
                }}
              >
                <SelectTrigger aria-label={t('kubecode.research.entryKind')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="note">{t('kubecode.research.entryKind.note')}</SelectItem>
                  <SelectItem value="decision">{t('kubecode.research.entryKind.decision')}</SelectItem>
                </SelectContent>
              </Select>
              <Button aria-busy={entry.busy} disabled={!body.trim() || entry.busy} size="sm" type="submit">
                {t('kubecode.research.addEntry')}
              </Button>
            </div>
            {entry.error && <p className="kubecode-research-error" role="alert">{entry.error}</p>}
          </form>
        )}
      </section>
    </div>
  )
}
