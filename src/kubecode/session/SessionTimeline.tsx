import { AiPanelMessageHistory } from '@/components/AiPanelChrome'
import { Button } from '@/components/ui/button'
import type { AppLocale } from '@/lib/i18n'

import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { ConversationRevision } from '../api'
import { RevisionNavigator } from './RevisionNavigator'
import type { Translator } from './sessionModel'

type SessionTimelineProps = {
  agentLabel: string
  historyCursor: string | null
  isActive: boolean
  loadingEarlier: boolean
  locale: AppLocale
  messages: AiAgentMessage[]
  onEditMessage?: (messageId: string, message: string) => void
  onLoadEarlierHistory: () => void
  onRegenerateMessage?: (messageId: string) => void
  onSelectRevision: (index: number) => void
  recreatedContext: boolean
  readiness: 'ready' | 'missing'
  revisions: ConversationRevision[]
  t: Translator
  viewRevisionId: string | null
}

export function SessionTimeline({
  agentLabel,
  historyCursor,
  isActive,
  loadingEarlier,
  locale,
  messages,
  onEditMessage,
  onLoadEarlierHistory,
  onRegenerateMessage,
  onSelectRevision,
  recreatedContext,
  readiness,
  revisions,
  t,
  viewRevisionId,
}: SessionTimelineProps) {
  return (
    <div className="kubecode-session-timeline">
      <AiPanelMessageHistory
        agentLabel={agentLabel}
        agentReadiness={readiness}
        hasContext
        isActive={isActive}
        leadingContent={(
          <>
            {historyCursor && (
              <Button
                className="kubecode-load-earlier"
                disabled={loadingEarlier}
                size="sm"
                variant="ghost"
                onClick={() => void onLoadEarlierHistory()}
              >
                {loadingEarlier ? t('kubecode.loading') : t('kubecode.loadEarlierMessages')}
              </Button>
            )}
            {recreatedContext && !viewRevisionId && (
              <div className="kubecode-recreated-context">{t('kubecode.recreatedContext')}</div>
            )}
            {revisions.length > 0 && (
              <RevisionNavigator
                activeIndex={viewRevisionId
                  ? revisions.findIndex((revision) => (
                    revision.snapshot_conversation_id === viewRevisionId
                  ))
                  : revisions.length}
                onSelect={onSelectRevision}
                t={t}
                total={revisions.length + 1}
              />
            )}
          </>
        )}
        locale={locale}
        messages={messages}
        onEditMessage={onEditMessage}
        onRegenerateMessage={onRegenerateMessage}
      />
    </div>
  )
}
