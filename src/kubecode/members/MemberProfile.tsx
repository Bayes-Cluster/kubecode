import { MessageCircle } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { Member } from '../api'
import { DetailPane } from '../app/DetailPane'
import { agentName } from '../session/sessionModel'
import { STATE_LABELS, TEMPLATE_LABELS } from './memberModel'

export type MemberProfileProps = {
  member: Member
  t: Translator
  onClose: () => void
  onOpenDm: (member: Member) => void
}

/**
 * An agent as the researcher meets it: its role, provider, standing
 * instructions, and the way to talk to it privately. Setup and removal stay
 * with the roster.
 */
export function MemberProfile({ member, onClose, onOpenDm, t }: MemberProfileProps) {
  return (
    <DetailPane label={member.name} onClose={onClose}>
      <header>
        <AiAgentIcon agent={member.spec.agent_id} size={18} />
        <h3>{member.name}</h3>
        <StatusBadge tone={member.state === 'active' ? 'ok' : 'warn'}>
          {t(STATE_LABELS[member.state])}
        </StatusBadge>
        <Button size="xs" variant="ghost" onClick={onClose}>{t('kubecode.nav.closeDetail')}</Button>
      </header>
      <dl className="kubecode-detail-facts">
        <dt>@{member.handle}</dt>
        <dd>{t(TEMPLATE_LABELS[member.template])} · {agentName(member.spec.agent_id)}</dd>
        {member.role === 'general' && <dd className="kubecode-research-muted">{t('kubecode.members.managerNote')}</dd>}
      </dl>
      {member.spec.instructions && (
        <>
          <h4>{t('kubecode.members.instructions')}</h4>
          <p className="kubecode-channel-body">{member.spec.instructions}</p>
        </>
      )}
      {member.state === 'active' && (
        <Button size="sm" variant="outline" onClick={() => onOpenDm(member)}>
          <MessageCircle aria-hidden size={14} />
          {t('kubecode.members.messagePrivately', { name: member.name })}
        </Button>
      )}
    </DetailPane>
  )
}
