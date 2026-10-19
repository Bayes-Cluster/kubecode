import { Plus, RotateCw, Trash2 } from 'lucide-react'
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
import { agentName } from '../session/sessionModel'
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
  projectId: string
  t: Translator
}

type Draft = {
  id: string | null
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
  agents, api, connectionState, defaults, events, onOpenMember, projectId, t,
}: MemberRosterProps) {
  const { roster, status, reload } = useMembers(api, projectId, events, connectionState)
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
      reload()
    } catch (cause) {
      setError(memberErrorMessage(cause, t))
      if (isMemberStale(cause)) reload()
    } finally {
      setBusy(false)
    }
  }

  const startAdd = () => {
    const template: MemberTemplate = 'analysis'
    setDraft({
      id: null,
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
        client_request_id: crypto.randomUUID(),
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
      <p className="kubecode-research-muted" role={status === 'error' ? 'alert' : 'status'}>
        {status === 'error' ? t('kubecode.members.loadFailed') : t('kubecode.members.loading')}
      </p>
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
              {member.setup_error && (
                <small className="kubecode-research-error">{member.setup_error}</small>
              )}
            </div>
            <span className="kubecode-research-badge" data-tone={member.state === 'active' ? 'ok' : 'warn'}>
              {t(STATE_LABELS[member.state])}
            </span>
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
            {member.role === 'specialist' && (
              <Button
                aria-label={`${t('kubecode.members.remove')}: ${member.name}`}
                disabled={busy}
                size="icon-xs"
                variant="ghost"
                onClick={() => void run(() => api.removeMember(projectId, member.id))}
              >
                <Trash2 aria-hidden size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>

      {draft && (
        <form
          aria-label={draft.id === null ? t('kubecode.members.add') : t('kubecode.members.edit')}
          className="kubecode-member-form"
          onSubmit={(event) => {
            event.preventDefault()
            save()
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
                  setDraft({
                    ...draft,
                    template,
                    instructions: draft.id === null
                      ? defaults?.templates[template] ?? draft.instructions
                      : draft.instructions,
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
    </section>
  )
}
