import { useState } from 'react'
import { Lock } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldTitle } from '@/components/ui/field'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'

import { useInspectorServices } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import type { InspectorPanelProps } from '../app/inspector/inspectorPanels'
import type { InspectorEntry } from '../app/location/inspector'
import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'
import { agentName } from '../session/sessionModel'
import { Identity } from './Identity'
import { memberView } from './memberIdentity'
import { ACTIVITY_LABELS, memberActivity, STATE_LABELS, TEMPLATE_LABELS } from './memberModel'

/** Instructions longer than this start collapsed. */
const LONG_INSTRUCTIONS = 280

/**
 * A member's profile in the inspector (ADR 0229 §1): who they are in the
 * shared identity, their responsibility and provider, their instructions, and
 * the ways to talk to them privately or manage them. Setup and removal stay in
 * Members. A member no longer on the roster is unavailable, with Back and
 * Close kept.
 */
export function MemberPanel({ entry }: InspectorPanelProps<Extract<InspectorEntry, { kind: 'member' }>>) {
  const { roster, sessionCatalog, t } = useInspectorServices()
  const navigation = useWorkspaceNavigation()
  const [expanded, setExpanded] = useState(false)
  const member = roster.find((item) => item.id === entry.id)
  if (!member) return <InspectorPanel status="unavailable" title={t('kubecode.inspector.memberDetail')} />
  const instructions = member.spec.instructions
  const long = instructions.length > LONG_INSTRUCTIONS
  const inMembers = navigation.location.place.view === 'members'
  const activity = memberActivity(member, sessionCatalog)
  return (
    <InspectorPanel
      actions={member.state === 'active' ? (
        <Button size="sm" variant="outline" onClick={() => navigation.openPlace({ view: 'dm', member: member.id })}>
          <Icon role="command" source={WORKSPACE_DESTINATION_ICONS.directMessage.Icon} />
          {t('kubecode.members.messagePrivately', { name: member.name })}
        </Button>
      ) : undefined}
      icon={<AiAgentIcon agent={member.spec.agent_id} size={18} />}
      title={member.name}
    >
      <div className="kubecode-member-profile" data-ws-components="official">
        {/* The profile is already open: the name is not a way into it. */}
        <Identity view={{ ...memberView(member, t), memberId: undefined }} />
        <FieldGroup className="kubecode-member-facts">
          <Field orientation="horizontal">
            <FieldTitle>{t('kubecode.members.role')}</FieldTitle>
            <span>{t(TEMPLATE_LABELS[member.template])}</span>
          </Field>
          <Field orientation="horizontal">
            <FieldTitle>{t('kubecode.members.provider')}</FieldTitle>
            <span>{agentName(member.spec.agent_id)}</span>
          </Field>
          {/* An active membership is not a status (ADR 0229 §1); only one that needs the researcher is. */}
          {member.state !== 'active' && (
            <Field orientation="horizontal">
              <FieldTitle>{t('kubecode.members.profile.membership')}</FieldTitle>
              <StatusBadge tone="warn">{t(STATE_LABELS[member.state])}</StatusBadge>
            </Field>
          )}
          <Field orientation="horizontal">
            <FieldTitle>{t('kubecode.members.profile.execution')}</FieldTitle>
            {activity
              ? <StatusBadge tone={activity === 'running' ? 'info' : 'warn'}>{t(ACTIVITY_LABELS[activity])}</StatusBadge>
              : <span>{t('kubecode.members.profile.idle')}</span>}
          </Field>
        </FieldGroup>
        {member.role === 'general' && (
          <section aria-label={t('kubecode.members.profile.restrictions')} className="kubecode-member-restrictions">
            <h4><Lock aria-hidden size={12} />{t('kubecode.members.profile.restrictions')}</h4>
            <p>{t('kubecode.members.profile.restrictionsBody')}</p>
            <p className="kubecode-research-muted">{t('kubecode.members.managerNote')}</p>
          </section>
        )}
        {instructions && (
          <section className="kubecode-member-instructions">
            <h4>{t('kubecode.members.instructions')}</h4>
            <p className="kubecode-channel-body" data-expanded={!long || expanded}>
              {long && !expanded ? `${instructions.slice(0, LONG_INSTRUCTIONS)}…` : instructions}
            </p>
            {long && (
              <Button size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
                <Icon role="command" source={(expanded ? WORKSPACE_COMMAND_ICONS.collapse : WORKSPACE_COMMAND_ICONS.expand).Icon} />
                {expanded ? t('kubecode.vocab.command.collapse') : t('kubecode.vocab.command.expand')}
              </Button>
            )}
          </section>
        )}
        {!inMembers && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigation.openPlace({ view: 'members' }, { inspect: { kind: 'member', id: member.id } })}
          >
            {t('kubecode.members.profile.manage')}
          </Button>
        )}
      </div>
    </InspectorPanel>
  )
}
