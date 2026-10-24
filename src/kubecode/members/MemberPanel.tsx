import { useState } from 'react'
import { Lock } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldTitle } from '@/components/ui/field'
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
import { statusToneVariant } from '../statusTone'

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
      <div className="flex flex-col gap-4">
        {/* The profile is already open: the name is not a way into it. */}
        <Identity view={{ ...memberView(member, t), memberId: undefined }} />
        <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <FieldTitle>{t('kubecode.members.role')}</FieldTitle>
            <span className="text-sm">{t(TEMPLATE_LABELS[member.template])}</span>
          </Field>
          <Field orientation="horizontal">
            <FieldTitle>{t('kubecode.members.provider')}</FieldTitle>
            <span className="text-sm">{agentName(member.spec.agent_id)}</span>
          </Field>
          {/* An active membership is not a status (ADR 0229 §1); only one that needs the researcher is. */}
          {member.state !== 'active' && (
            <Field orientation="horizontal">
              <FieldTitle>{t('kubecode.members.profile.membership')}</FieldTitle>
              <Badge variant="warning">{t(STATE_LABELS[member.state])}</Badge>
            </Field>
          )}
          <Field orientation="horizontal">
            <FieldTitle>{t('kubecode.members.profile.execution')}</FieldTitle>
            {activity
              ? <Badge variant={statusToneVariant(activity === 'running' ? 'info' : 'warn')}>{t(ACTIVITY_LABELS[activity])}</Badge>
              : <span className="text-sm">{t('kubecode.members.profile.idle')}</span>}
          </Field>
        </FieldGroup>
        {member.role === 'general' && (
          <section aria-label={t('kubecode.members.profile.restrictions')}>
            <Alert>
              <Lock />
              <AlertTitle><h4>{t('kubecode.members.profile.restrictions')}</h4></AlertTitle>
              <AlertDescription>
                <p>{t('kubecode.members.profile.restrictionsBody')}</p>
                <p>{t('kubecode.members.managerNote')}</p>
              </AlertDescription>
            </Alert>
          </section>
        )}
        {instructions && (
            <Field>
              <FieldTitle><h4>{t('kubecode.members.instructions')}</h4></FieldTitle>
              <p className="text-sm break-words whitespace-pre-wrap">
                {long && !expanded ? `${instructions.slice(0, LONG_INSTRUCTIONS)}…` : instructions}
              </p>
              {long && (
                  <Button
                    aria-expanded={expanded}
                    className="self-start"
                    size="xs"
                    variant="ghost"
                    onClick={() => setExpanded((value) => !value)}
                  >
                    <Icon role="command" source={(expanded ? WORKSPACE_COMMAND_ICONS.collapse : WORKSPACE_COMMAND_ICONS.expand).Icon} />
                    {expanded ? t('kubecode.vocab.command.collapse') : t('kubecode.vocab.command.expand')}
                  </Button>
              )}
            </Field>
        )}
        {!inMembers && (
          <Button
            className="self-start"
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
