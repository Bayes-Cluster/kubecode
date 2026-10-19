import { MessageCircle, Plus, RotateCw, Trash2 } from 'lucide-react'
import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { useState } from 'react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  AgentId,
  KubecodeApi,
  Member,
  MemberDefaults,
  MemberTemplate,
  WorkspaceEvent,
} from '../api'
import { agentName, newClientMessageId } from '../session/sessionModel'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import {
  isMemberStale,
  memberErrorMessage,
  SPECIALIST_TEMPLATES,
  STATE_LABELS,
  TEMPLATE_LABELS,
} from './memberModel'
import { useMembers } from './useMembers'

export type MemberRosterProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  events: WorkspaceEvent[]
  /** Server defaults, for pre-filling a new member's instructions. */
  defaults?: MemberDefaults | null
  onOpenMember?: (member: Member) => void
  /** Opens the researcher's private conversation with a member. */
  onOpenDm?: (member: Member) => void
  projectId: string
  t: Translator
}

type Draft = {
  id: string | null
  /** One idempotency key per add form, so a retried Save is one member. */
  requestId: string
  /** The template instructions the form was last filled from, to know if they were edited. */
  filledFrom: string
  revision: number
  name: string
  template: MemberTemplate
  agentId: AgentId
  instructions: string
  /** The provider of a member that already has a Session is replaced, not edited. */
  providerLocked: boolean
}

/**
 * Who works in this Workspace: the General Agent (the project manager) and
 * the specialists. Setup problems show on the member with a retry; removing a
 * member keeps its history and is refused while it holds open work.
 */
export function MemberRoster({
  agents, api, connectionState, defaults, events, onOpenDm, onOpenMember, projectId, t,
}: MemberRosterProps) {
  const { roster, status, refreshFailed, reload } = useMembers(api, projectId, events, connectionState)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<{ id: string; agentId: AgentId } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = agents.filter((agent) => agent.available)
  const defaultAgent: AgentId = available[0]?.id ?? agents[0]?.id ?? 'claude_code'

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      setDraft(null)
      setConfirming(null)
      setReplacing(null)
      reload()
    } catch (cause) {
      setError(memberErrorMessage(cause, t))
      if (isMemberStale(cause)) {
        // The form was built from a revision that is gone: start over from the
        // refreshed roster rather than resubmit the same conflict.
        setDraft(null)
        reload()
      }
    } finally {
      setBusy(false)
    }
  }

  const startAdd = () => {
    const template: MemberTemplate = 'analysis'
    setDraft({
      id: null,
      requestId: newClientMessageId(),
      filledFrom: defaults?.templates[template] ?? '',
      revision: 0,
      name: '',
      template,
      agentId: defaults?.general.agent_id ?? defaultAgent,
      instructions: defaults?.templates[template] ?? '',
      providerLocked: false,
    })
  }

  const save = () => {
    if (!draft) return
    const spec = (member?: Member) => ({
      agent_id: draft.agentId,
      config: member?.spec.config ?? {},
      instructions: draft.instructions,
    })
    if (draft.id === null) {
      void run(() => api.createMember(projectId, {
        name: draft.name,
        template: draft.template,
        spec: spec(),
        client_request_id: draft.requestId,
      }))
    } else {
      const member = roster?.members.find((candidate) => candidate.id === draft.id)
      void run(() => api.updateMember(projectId, draft.id!, draft.revision, {
        name: draft.name,
        template: member?.role === 'general' ? undefined : draft.template,
        spec: spec(member),
      }))
    }
  }

  if (!roster) {
    return (
      <div>
        <p className="kubecode-research-muted" role={status === 'error' ? 'alert' : 'status'}>
          {status === 'error' ? t('kubecode.members.loadFailed') : t('kubecode.members.loading')}
        </p>
        {status === 'error' && (
          <Button size="xs" variant="outline" onClick={reload}>{t('kubecode.members.retryLoad')}</Button>
        )}
      </div>
    )
  }

  return (
    <section aria-label={t('kubecode.members.title')} className="kubecode-members">
      <header className="kubecode-members-header">
        <h3>{t('kubecode.members.title')}</h3>
        <Button disabled={busy} size="sm" variant="outline" onClick={startAdd}>
          <Plus aria-hidden size={14} />
          {t('kubecode.members.add')}
        </Button>
      </header>
      {error && <p className="kubecode-research-error" role="alert">{error}</p>}
      {refreshFailed && (
        <p className="kubecode-research-muted" role="status">{t('kubecode.members.refreshFailed')}</p>
      )}
      <ul className="kubecode-member-list">
        {roster.members.map((member) => (
          <li data-state={member.state} key={member.id}>
            <AiAgentIcon agent={member.spec.agent_id} size={18} />
            <div className="kubecode-member-main">
              {onOpenMember ? (
                <Button size="xs" variant="ghost" onClick={() => onOpenMember(member)}>
                  {member.name}
                </Button>
              ) : <strong>{member.name}</strong>}
              <small>
                @{member.handle} · {t(TEMPLATE_LABELS[member.template])} · {agentName(member.spec.agent_id)}
              </small>
              {member.role === 'general' && (
                <small className="kubecode-research-muted">{t('kubecode.members.managerNote')}</small>
              )}
              {member.setup_code === 'provider_unavailable' && (
                <small className="kubecode-research-error">
                  {t('kubecode.members.setup.providerUnavailable', { provider: agentName(member.spec.agent_id) })}
                </small>
              )}
              {member.setup_code === 'config_rejected' && (
                <small className="kubecode-research-error">
                  {t('kubecode.members.setup.configRejected')}
                  {member.setup_error ? ` (${member.setup_error})` : ''}
                </small>
              )}
            </div>
            <StatusBadge tone={member.state === 'active' ? 'ok' : 'warn'}>
              {t(STATE_LABELS[member.state])}
            </StatusBadge>
            {member.state === 'setup_required' && (
              <Button
                aria-label={`${t('kubecode.members.retrySetup')}: ${member.name}`}
                disabled={busy}
                size="xs"
                variant="outline"
                onClick={() => void run(() => api.retryMemberSetup(projectId, member.id))}
              >
                <RotateCw aria-hidden size={14} />
                {t('kubecode.members.retrySetup')}
              </Button>
            )}
            <Button
              aria-label={`${t('kubecode.members.edit')}: ${member.name}`}
              disabled={busy}
              size="xs"
              variant="ghost"
              onClick={() => setDraft({
                id: member.id,
                requestId: '',
                filledFrom: member.spec.instructions,
                revision: member.revision,
                name: member.name,
                template: member.template,
                agentId: member.spec.agent_id,
                instructions: member.spec.instructions,
                providerLocked: member.public_conversation_id !== null || member.dm_conversation_id !== null,
              })}
            >
              {t('kubecode.members.edit')}
            </Button>
            {onOpenDm && member.state === 'active' && (
              <IconButton
                disabled={busy}
                icon={<MessageCircle aria-hidden size={14} />}
                label={t('kubecode.members.messagePrivately', { name: member.name })}
                onClick={() => onOpenDm(member)}
              />
            )}
            {member.public_conversation_id !== null && (
              <Button
                aria-label={`${t('kubecode.members.replaceSession')}: ${member.name}`}
                disabled={busy}
                size="xs"
                variant="ghost"
                onClick={() => setReplacing({ id: member.id, agentId: member.spec.agent_id })}
              >
                {t('kubecode.members.replaceSession')}
              </Button>
            )}
            {member.role === 'specialist' && (confirming === member.id ? (
              <Button
                aria-label={`${t('kubecode.members.confirmRemove')}: ${member.name}`}
                disabled={busy}
                size="xs"
                variant="destructive"
                onClick={() => void run(() => api.removeMember(projectId, member.id))}
              >
                {t('kubecode.members.confirmRemove')}
              </Button>
            ) : (
              <IconButton
                disabled={busy}
                icon={<Trash2 aria-hidden size={14} />}
                label={`${t('kubecode.members.remove')}: ${member.name}`}
                onClick={() => setConfirming(member.id)}
              />
            ))}
          </li>
        ))}
      </ul>

      {draft && (
        <form
          aria-label={draft.id === null ? t('kubecode.members.add') : t('kubecode.members.edit')}
          className="kubecode-member-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy) save()
          }}
        >
          <label>
            <span>{t('kubecode.members.name')}</span>
            <input
              className="kubecode-channel-select"
              maxLength={60}
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          {(draft.id === null || roster.members.find((m) => m.id === draft.id)?.role === 'specialist') && (
            <label>
              <span>{t('kubecode.members.role')}</span>
              <select
                className="kubecode-channel-select"
                value={draft.template}
                onChange={(event) => {
                  const template = event.target.value as MemberTemplate
                  // New instructions follow the template unless they were edited.
                  const follows = draft.id === null && draft.instructions === draft.filledFrom
                  const filled = defaults?.templates[template] ?? ''
                  setDraft({
                    ...draft,
                    template,
                    filledFrom: follows ? filled : draft.filledFrom,
                    instructions: follows ? filled : draft.instructions,
                  })
                }}
              >
                {SPECIALIST_TEMPLATES.map((template) => (
                  <option key={template} value={template}>{t(TEMPLATE_LABELS[template])}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>{t('kubecode.members.provider')}</span>
            <select
              className="kubecode-channel-select"
              disabled={draft.providerLocked}
              value={draft.agentId}
              onChange={(event) => setDraft({ ...draft, agentId: event.target.value as AgentId })}
            >
              {agents.map((agent) => (
                <option disabled={!agent.available} key={agent.id} value={agent.id}>
                  {agentName(agent.id)}{agent.available ? '' : ` — ${t('kubecode.unavailable')}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('kubecode.members.instructions')}</span>
            <Textarea
              rows={5}
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </label>
          <div className="kubecode-work-command-row">
            <Button disabled={busy || draft.name.trim() === ''} size="sm" type="submit">
              {t('kubecode.members.save')}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setDraft(null)}>
              {t('kubecode.members.cancel')}
            </Button>
          </div>
        </form>
      )}
      {replacing && (
        <form
          aria-label={t('kubecode.members.replaceSession')}
          className="kubecode-member-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy) return
            const member = roster.members.find((candidate) => candidate.id === replacing.id)
            void run(() => api.replaceMemberSession(
              projectId,
              replacing.id,
              member ? { ...member.spec, agent_id: replacing.agentId } : undefined,
            ))
          }}
        >
          <p className="kubecode-research-muted">{t('kubecode.members.replaceHelp')}</p>
          <label>
            <span>{t('kubecode.members.provider')}</span>
            <select
              className="kubecode-channel-select"
              value={replacing.agentId}
              onChange={(event) => setReplacing({ ...replacing, agentId: event.target.value as AgentId })}
            >
              {agents.map((agent) => (
                <option disabled={!agent.available} key={agent.id} value={agent.id}>
                  {agentName(agent.id)}{agent.available ? '' : ` — ${t('kubecode.unavailable')}`}
                </option>
              ))}
            </select>
          </label>
          <div className="kubecode-work-command-row">
            <Button disabled={busy} size="sm" type="submit">{t('kubecode.members.replaceConfirm')}</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setReplacing(null)}>
              {t('kubecode.members.cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
