import { Ellipsis, TriangleAlert } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'
import { cn } from '@/lib/utils'

import type { Conversation, TeamSnapshot } from '../api'
import { UsageMeter } from './UsageMeter'

type SessionTitlebarProps = {
  active: boolean
  canFork: boolean
  conversation: Conversation
  leaderReviewPending: boolean
  locale: string
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
  usage: unknown
  waitingForInput: boolean
}

export function SessionTitlebar({
  active,
  canFork,
  conversation,
  leaderReviewPending,
  locale,
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
  usage,
  waitingForInput,
}: SessionTitlebarProps) {
  return (
    <div className="kubecode-session-titlebar-content">
      <div className="kubecode-session-title">
        <AiAgentIcon agent={conversation.agent_id} size={18} />
        <strong>{conversation.title || t('kubecode.untitledSession')}</strong>
      </div>
      <UsageMeter locale={locale} t={t} usage={usage} />
      {team && (
        // A view switch, not tabs: the Chat and Team views are rendered by the
        // workspace, so there is no tab panel for a tab to control.
        <ToggleGroup
          aria-label={t('kubecode.teamSession')}
          className="kubecode-team-view-switch"
          size="sm"
          type="single"
          value={teamView}
          variant="outline"
          onValueChange={(value) => {
            if (value !== 'chat' && value !== 'team') return
            onTeamViewChange(value)
            if (value === 'team') {
              trackEvent('kubecode_team_view_opened', { team_size: team.members.length })
            }
          }}
        >
          <ToggleGroupItem value="chat">{t('kubecode.chat')}</ToggleGroupItem>
          <ToggleGroupItem value="team">
            {t('kubecode.teamSession')}
            {team.summary?.needs_attention > 0 && (
              <Badge variant="destructive">{team.summary.needs_attention}</Badge>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      )}
      <div className="kubecode-session-status">
        <Badge
          className={cn('kubecode-session-status-badge', !waitingForInput && !active && 'is-idle')}
          variant={waitingForInput ? 'warning' : active ? 'info' : 'secondary'}
        >
          {waitingForInput ? <TriangleAlert aria-hidden="true" /> : active && <Spinner aria-hidden="true" aria-label={undefined} role={undefined} />}
          <span className="kubecode-session-status-label">
            {waitingForInput
              ? t(pendingElicitation
                ? 'kubecode.answerAgentQuestion'
                : leaderReviewPending
                  ? 'kubecode.waitingForLeaderPermission'
                  : 'kubecode.permissionRequired')
              : active ? t('kubecode.running') : t('kubecode.ready')}
          </span>
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={t('kubecode.sessionActions')} className="kubecode-touch-target" size="icon-xs" variant="ghost">
              <Ellipsis />
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
