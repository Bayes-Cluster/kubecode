import { UsersThree } from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Translator } from '@/lib/i18n'

import type { TeamSnapshot } from './api'
import { Icon } from './icons'
import { TEAM_MEMBER_STATUS_ICONS } from './icons/statusIcons'

export function TeamSessionOverview({
  activeConversationId,
  onSelectMember,
  snapshot,
  t,
}: {
  activeConversationId: string
  onSelectMember: (conversationId: string) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const conversations = new Map(snapshot.conversations.map((item) => [item.id, item]))
  return (
    <TooltipProvider>
      <section className="kubecode-team-overview">
        <div className="kubecode-team-overview-title">
          <UsersThree />
          <strong>{snapshot.team.title || snapshot.leader_conversation.title}</strong>
        </div>
        <div className="kubecode-team-member-tree">
          {snapshot.members.map((member) => {
            const conversation = conversations.get(member.conversation_id)
            if (!conversation) return null
            return (
              <Button
                aria-label={member.name}
                data-active={member.conversation_id === activeConversationId}
                key={member.id}
                size="sm"
                variant="ghost"
                onClick={() => onSelectMember(member.conversation_id)}
              >
                <AiAgentIcon agent={conversation.agent_id} size={18} />
                <span>{member.name}</span>
                <MemberStatus status={member.status} t={t} />
              </Button>
            )
          })}
        </div>
      </section>
    </TooltipProvider>
  )
}

function MemberStatus({
  status,
  t,
}: {
  status: TeamSnapshot['members'][number]['status']
  t: Translator
}) {
  const entry = TEAM_MEMBER_STATUS_ICONS[status]
  return (
    <span className="kubecode-team-member-status-group">
      <Icon label={t(entry.labelKey)} role="status" size="secondary" source={entry.Icon} />
      <i aria-hidden="true" className="kubecode-team-member-status" data-status={status} />
    </span>
  )
}
