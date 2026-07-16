import { CheckCircle, Circle, SpinnerGap, UsersThree } from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'

import type { TeamSnapshot } from './api'

export function TeamSessionOverview({
  activeConversationId,
  onSelectMember,
  snapshot,
}: {
  activeConversationId: string
  onSelectMember: (conversationId: string) => void
  snapshot: TeamSnapshot
}) {
  const conversations = new Map(snapshot.conversations.map((item) => [item.id, item]))
  const acceptedTasks = snapshot.tasks.filter((task) => task.status === 'accepted').length
  return (
    <section className="kubecode-team-overview">
      <div className="kubecode-team-overview-title">
        <UsersThree />
        <strong>{snapshot.team.title || snapshot.leader_conversation.title}</strong>
        {snapshot.tasks.length > 0 && <small>{acceptedTasks}/{snapshot.tasks.length}</small>}
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
              <MemberStatus status={member.status} />
            </Button>
          )
        })}
      </div>
      {snapshot.tasks.length > 0 && (
        <div className="kubecode-team-task-strip">
          {snapshot.tasks.map((task) => (
            <span key={task.id} title={task.description}>
              {task.status === 'accepted'
                ? <CheckCircle weight="fill" />
                : task.status === 'in_progress'
                  ? <SpinnerGap className="kubecode-spin" />
                  : <Circle />}
              {task.title}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function MemberStatus({ status }: { status: TeamSnapshot['members'][number]['status'] }) {
  return <i className="kubecode-team-member-status" data-status={status} />
}
