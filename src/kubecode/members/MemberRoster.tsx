import { CircleAlert, Info, Lock, MessageCircle, Plus, RotateCw, Trash2, UserRound } from 'lucide-react'
import { useId, useState } from 'react'

import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  AgentId,
  Conversation,
  KubecodeApi,
  Member,
  MemberDefaults,
  MemberTemplate,
  WorkspaceEvent,
} from '../api'
import { agentName, newClientMessageId } from '../session/sessionModel'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import {
  ACTIVITY_LABELS,
  isMemberStale,
  memberActivity,
  memberErrorMessage,
  SPECIALIST_TEMPLATES,
  TEMPLATE_LABELS,
} from './memberModel'
import { Identity } from './Identity'
import { ProviderSelect } from './ProviderSelect'
import { memberView } from './memberIdentity'
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
  /** The Workspace's Sessions, to show what a member is executing apart from its membership. */
  sessions?: readonly Conversation[]
  t: Translator
}

const NO_SESSIONS: readonly Conversation[] = []


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
  agents, api, connectionState, defaults, events, onOpenDm, onOpenMember, projectId, sessions = NO_SESSIONS, t,
}: MemberRosterProps) {
  const { roster, status, refreshFailed, reload } = useMembers(api, projectId, events, connectionState)
  const fieldId = useId()
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
      status === 'error' ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{t('kubecode.members.loadFailed')}</AlertTitle>
          <AlertDescription>
            <Button size="sm" variant="outline" onClick={reload}>{t('kubecode.members.retryLoad')}</Button>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          {t('kubecode.members.loading')}
        </p>
      )
    )
  }

  const draftForm = draft && (
        <form
          aria-label={draft.id === null ? t('kubecode.members.add') : t('kubecode.members.edit')}
          className="w-full rounded-md border p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy) save()
          }}
        >
          <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor={`${fieldId}-name`}>{t('kubecode.members.name')}</FieldLabel>
            <Input
              id={`${fieldId}-name`}
              maxLength={60}
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          {draft.id !== null && roster.members.find((m) => m.id === draft.id)?.role === 'general' && (
            <Alert role="note">
              <Lock />
              <AlertDescription>{t('kubecode.members.managerLocked')}</AlertDescription>
            </Alert>
          )}
          {(draft.id === null || roster.members.find((m) => m.id === draft.id)?.role === 'specialist') && (
            <Field>
              <FieldLabel htmlFor={`${fieldId}-role`}>{t('kubecode.members.role')}</FieldLabel>
              <Select
                value={draft.template}
                onValueChange={(next) => {
                  const template = next as MemberTemplate
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
                <SelectTrigger className="w-full sm:w-56" id={`${fieldId}-role`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SPECIALIST_TEMPLATES.map((template) => (
                      <SelectItem key={template} value={template}>{t(TEMPLATE_LABELS[template])}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field data-disabled={draft.providerLocked || undefined}>
            <FieldLabel htmlFor={`${fieldId}-provider`}>{t('kubecode.members.provider')}</FieldLabel>
            <ProviderSelect
              agents={agents}
              describedBy={draft.providerLocked ? `${fieldId}-provider-locked` : undefined}
              disabled={draft.providerLocked}
              id={`${fieldId}-provider`}
              t={t}
              value={draft.agentId}
              onChange={(agentId) => setDraft({ ...draft, agentId })}
            />
            {draft.providerLocked && (
              <FieldDescription id={`${fieldId}-provider-locked`}>{t('kubecode.members.providerLocked')}</FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-instructions`}>{t('kubecode.members.instructions')}</FieldLabel>
            <Textarea
              id={`${fieldId}-instructions`}
              rows={5}
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </Field>
          <Field orientation="horizontal">
            <Button disabled={busy || draft.name.trim() === ''} size="sm" type="submit">
              {busy && <Spinner aria-hidden="true" data-icon="inline-start" />}
              {t('kubecode.members.save')}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setDraft(null)}>
              {t('kubecode.members.cancel')}
            </Button>
          </Field>
          </FieldGroup>
        </form>
  )

  const replacingForm = replacing && (
        <form
          aria-label={t('kubecode.members.replaceSession')}
          className="w-full rounded-md border p-4"
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
          <FieldGroup className="gap-4">
          <FieldDescription>{t('kubecode.members.replaceHelp')}</FieldDescription>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-replace-provider`}>{t('kubecode.members.provider')}</FieldLabel>
            <ProviderSelect
              agents={agents}
              id={`${fieldId}-replace-provider`}
              t={t}
              value={replacing.agentId}
              onChange={(agentId) => setReplacing({ ...replacing, agentId })}
            />
          </Field>
          <Field orientation="horizontal">
            <Button disabled={busy} size="sm" type="submit">{t('kubecode.members.replaceConfirm')}</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setReplacing(null)}>
              {t('kubecode.members.cancel')}
            </Button>
          </Field>
          </FieldGroup>
        </form>
  )

  return (
    <section aria-label={t('kubecode.members.title')} className="flex flex-col gap-4">
      <Item size="sm">
        <ItemContent>
          <ItemTitle><h3>{t('kubecode.members.current.title')}</h3></ItemTitle>
          <ItemDescription>{t('kubecode.members.current.description')}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button disabled={busy} size="sm" variant="outline" onClick={startAdd}>
            <Plus data-icon="inline-start" />
            {t('kubecode.members.add')}
          </Button>
        </ItemActions>
      </Item>
      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {refreshFailed && (
        <Alert role="status">
          <Info />
          <AlertDescription>{t('kubecode.members.refreshFailed')}</AlertDescription>
        </Alert>
      )}
      {draft?.id === null && draftForm}
      <ul className="flex flex-col gap-2">
        {roster.members.map((member) => {
          const activity = memberActivity(member, sessions)
          const manager = member.role === 'general'
          return (
          <Item asChild key={member.id} size="sm" variant="outline">
          <li
            className="flex-wrap items-start"
            data-focus-key={`member:${member.id}`}
            data-role={member.role}
            data-scroll-anchor={`member:${member.id}`}
            data-state={member.state}
          >
            <ItemContent className="min-w-60">
              <Identity
                activity={activity ? (
                  <StatusBadge tone={activity === 'running' ? 'info' : 'warn'}>{t(ACTIVITY_LABELS[activity])}</StatusBadge>
                ) : undefined}
                meta={(
                  <span className="inline-flex items-center gap-1">
                    <AiAgentIcon agent={member.spec.agent_id} size={14} />
                    {agentName(member.spec.agent_id)}
                  </span>
                )}
                view={memberView(member, t)}
                onOpen={onOpenMember ? () => onOpenMember(member) : undefined}
              />
              {manager && (
                <ItemDescription className="flex items-start gap-1.5">
                  <Lock aria-hidden className="mt-0.5 shrink-0" size={12} />
                  <span>{t('kubecode.members.managerNote')}</span>
                </ItemDescription>
              )}
              {member.setup_code === 'provider_unavailable' && (
                <small className="text-destructive">
                  {t('kubecode.members.setup.providerUnavailable', { provider: agentName(member.spec.agent_id) })}
                </small>
              )}
              {member.setup_code === 'config_rejected' && (
                <small className="text-destructive">
                  {t('kubecode.members.setup.configRejected')}
                  {member.setup_error ? ` (${member.setup_error})` : ''}
                </small>
              )}
            </ItemContent>
            <ItemActions className="flex-wrap">
            {member.state === 'setup_required' && (
              <Button
                aria-label={`${t('kubecode.members.retrySetup')}: ${member.name}`}
                data-focus-key={`member-setup:${member.id}`}
                disabled={busy}
                size="xs"
                variant="outline"
                onClick={() => void run(() => api.retryMemberSetup(projectId, member.id))}
              >
                <RotateCw data-icon="inline-start" />
                {t('kubecode.members.retrySetup')}
              </Button>
            )}
            {onOpenMember && (
              <IconButton
                icon={<UserRound aria-hidden size={14} />}
                label={t('kubecode.members.openProfile', { name: member.name })}
                onClick={() => onOpenMember(member)}
              />
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
            </ItemActions>
            {draft?.id === member.id && draftForm}
            {replacing?.id === member.id && replacingForm}
          </li>
          </Item>
          )
        })}
      </ul>

    </section>
  )
}
