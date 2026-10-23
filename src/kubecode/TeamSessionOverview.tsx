import { Users } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { StatusBadge, type StatusTone } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { TeamSnapshot } from './api'
import { TEAM_MEMBER_STATUS_ICONS } from './icons/statusIcons'

type MemberStatusValue = TeamSnapshot['members'][number]['status']

function teamMemberTone(status: MemberStatusValue): StatusTone {
  if (status === 'working') return 'info'
  if (status === 'failed') return 'danger'
  if (status === 'waiting_input' || status === 'waiting_permission') return 'warn'
  return 'muted'
}

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
    <section className="kubecode-team-overview" aria-label={snapshot.team.title || snapshot.leader_conversation.title}>
      <div className="flex min-w-0 shrink-0 items-center gap-2 text-sm font-medium">
        <Users aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">{snapshot.team.title || snapshot.leader_conversation.title}</span>
      </div>
      <ItemGroup className="kubecode-team-member-tree">
        {snapshot.members.map((member) => {
          const conversation = conversations.get(member.conversation_id)
          if (!conversation) return null
          const active = member.conversation_id === activeConversationId
          return (
            <Item asChild key={member.id} size="sm" variant={active ? 'muted' : 'default'}>
              <button
                aria-current={active ? 'true' : undefined}
                type="button"
                onClick={() => onSelectMember(member.conversation_id)}
              >
                <ItemMedia>
                  <AiAgentIcon agent={conversation.agent_id} size={18} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{member.name}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <MemberStatus status={member.status} t={t} />
                </ItemActions>
              </button>
            </Item>
          )
        })}
      </ItemGroup>
    </section>
  )
}

function MemberStatus({ status, t }: { status: MemberStatusValue; t: Translator }) {
  const entry = TEAM_MEMBER_STATUS_ICONS[status]
  const StatusIcon = entry.Icon
  return (
    <StatusBadge tone={teamMemberTone(status)}>
      <StatusIcon aria-hidden="true" />
      {t(entry.labelKey)}
    </StatusBadge>
  )
}
