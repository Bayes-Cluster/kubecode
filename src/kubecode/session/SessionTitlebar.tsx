import { Ellipsis } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type { Conversation, TeamSnapshot } from '../api'

type SessionTitlebarProps = {
  active: boolean
  canFork: boolean
  conversation: Conversation
  leaderReviewPending: boolean
  onForkSession: () => void
  onPromoteToTeam: () => void
  onRename: () => void
  onRequestDelete: () => void
  onRestoreAgentTitle: () => void
  onTeamViewChange: (view: 'chat' | 'team') => void
  pendingElicitation: boolean
  t: Translator
  team: TeamSnapshot | null
  teamView: 'chat' | 'team'
  waitingForInput: boolean
}

export function SessionTitlebar({
  active,
  canFork,
  conversation,
  leaderReviewPending,
  onForkSession,
  onPromoteToTeam,
  onRename,
  onRequestDelete,
  onRestoreAgentTitle,
  onTeamViewChange,
  pendingElicitation,
  t,
  team,
  teamView,
  waitingForInput,
}: SessionTitlebarProps) {
  return (
    <div className="kubecode-session-titlebar-content">
      <div className="kubecode-session-title">
        <AiAgentIcon agent={conversation.agent_id} size={18} />
        <strong>{conversation.title || t('kubecode.untitledSession')}</strong>
      </div>
      {team && (
        <div className="kubecode-team-view-switch" role="tablist">
          <Button
            aria-selected={teamView === 'chat'}
            role="tab"
            size="xs"
            variant={teamView === 'chat' ? 'secondary' : 'ghost'}
            onClick={() => onTeamViewChange('chat')}
          >
            {t('kubecode.chat')}
          </Button>
          <Button
            aria-selected={teamView === 'team'}
            role="tab"
            size="xs"
            variant={teamView === 'team' ? 'secondary' : 'ghost'}
            onClick={() => {
              onTeamViewChange('team')
              trackEvent('kubecode_team_view_opened', { team_size: team.members.length })
            }}
          >
            {t('kubecode.teamSession')}
            {team.summary?.needs_attention > 0 && <span>{team.summary.needs_attention}</span>}
          </Button>
        </div>
      )}
      <div className="kubecode-session-status">
        <span data-state={waitingForInput ? 'stuck' : active ? 'running' : 'idle'} />
        <span className="kubecode-session-status-label">
          {waitingForInput
            ? t(pendingElicitation
              ? 'kubecode.answerAgentQuestion'
              : leaderReviewPending
                ? 'kubecode.waitingForLeaderPermission'
                : 'kubecode.permissionRequired')
            : active ? t('kubecode.running') : t('kubecode.ready')}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={t('kubecode.sessionActions')} size="icon-xs" variant="ghost">
              <Ellipsis  size={16}/>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRename()}>
              {t('kubecode.renameSession')}
            </DropdownMenuItem>
            {conversation.manual_title && conversation.agent_title && (
              <DropdownMenuItem onSelect={() => void onRestoreAgentTitle()}>
                {t('kubecode.useAgentTitle')}
              </DropdownMenuItem>
            )}
            {canFork && (
              <DropdownMenuItem onSelect={() => void onForkSession()}>
                {t('kubecode.forkSession')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void onPromoteToTeam()}>
              {t('kubecode.promoteToTeam')}
            </DropdownMenuItem>
            {conversation.team_role !== 'teammate'
              && conversation.team_role !== 'discriminator'
              && !team?.members.some((member) => (
                member.conversation_id === conversation.id && member.role !== 'leader'
              )) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onRequestDelete}>
                  {t('kubecode.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
