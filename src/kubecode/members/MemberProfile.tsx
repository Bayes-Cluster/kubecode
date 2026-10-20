import { MessageCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { Member } from '../api'
import { agentName } from '../session/sessionModel'
import { TEMPLATE_LABELS } from './memberModel'

export type MemberProfileProps = {
  member: Member
  t: Translator
  onOpenDm: (member: Member) => void
}

/**
 * An agent as the researcher meets it: its role, provider, standing
 * instructions, and the way to talk to it privately. Content only: the
 * inspector draws the aside and the one header with the name, state, and
 * Back or Close (ADR 0228). Setup and removal stay with the roster.
 */
export function MemberProfile({ member, onOpenDm, t }: MemberProfileProps) {
  return (
    <div className="kubecode-member-profile">
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
    </div>
  )
}
