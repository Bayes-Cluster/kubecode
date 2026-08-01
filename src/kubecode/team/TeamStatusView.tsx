import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowRight,
  CheckCircle,
  Clock,
  Pause,
  Play,
  SpinnerGap,
  UsersThree,
  WarningCircle,
} from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { KubecodeApi, TeamSnapshot } from '../api'
import { SystemMessageNotice } from '../SystemMessageNotice'

export function TeamStatusView({
  api,
  busyAction,
  error,
  onPause,
  onReconfigure,
  onResume,
  onSelectMember,
  onSnapshotChange,
  setError,
  snapshot,
  t,
}: {
  api: KubecodeApi
  busyAction: string | null
  error: string | null
  onPause: () => void
  onReconfigure: () => void
  onResume: () => void
  onSelectMember: (conversationId: string) => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  setError: (value: string | null) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const attention = snapshot.attention ?? []
  const tasks = snapshot.tasks ?? []
  const summary = snapshot.summary ?? {
    running: 0,
    queued: 0,
    needs_attention: 0,
    done: 0,
    total_tasks: tasks.length,
  }

  const resolveUserInput = async (requestId: string) => {
    const answer = answers[requestId]?.trim()
    if (!answer) return
    setError(null)
    try {
      const updated = await api.resolveTeamUserInput(snapshot.team.id, requestId, answer)
      setAnswers((current) => ({ ...current, [requestId]: '' }))
      onSnapshotChange(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    }
  }

  return (
    <>
      <header className="kubecode-team-control-header">
        <div>
          <UsersThree weight="fill" />
          <div>
            <strong>{snapshot.team.title || snapshot.leader_conversation.title}</strong>
            <span>{t('kubecode.teamControlCenter')}</span>
          </div>
        </div>
        <div className="kubecode-team-settings">
          <span className="kubecode-team-status" data-status={snapshot.team.status}>
            {teamStatusLabel(snapshot.team.status, t)}
          </span>
          <span className="kubecode-team-mode-badge" data-mode={snapshot.team.mode}>
            {snapshot.team.mode === 'yolo' ? t('kubecode.teamYolo') : t('kubecode.teamStandard')}
          </span>
          {snapshot.team.status === 'needs_attention' && (
            <Button size="sm" variant="outline" onClick={onReconfigure}>
              {t('kubecode.teamReconfigure')}
            </Button>
          )}
          {snapshot.team.status === 'paused' ? (
            <Button
              disabled={busyAction !== null}
              size="sm"
              variant="outline"
              onClick={onResume}
            >
              <Play weight="fill" /> {t('kubecode.teamResume')}
            </Button>
          ) : ['active', 'verifying', 'needs_attention'].includes(snapshot.team.status) ? (
            <Button
              disabled={busyAction !== null}
              size="sm"
              variant="outline"
              onClick={onPause}
            >
              <Pause weight="fill" /> {t('kubecode.teamPause')}
            </Button>
          ) : null}
        </div>
      </header>

      {error && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}
      {snapshot.team.mode_fallback && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
          dismissLabel={t('window.close')}
          level="warning"
          message={`${t('kubecode.teamYoloFallback')}: ${snapshot.team.mode_fallback.reason}`}
        />
      )}

      <div className="kubecode-team-metrics">
        <Metric icon={<SpinnerGap />} label={t('kubecode.teamRunning')} name="running" value={summary.running} />
        <Metric icon={<Clock />} label={t('kubecode.teamQueued')} name="queued" value={summary.queued} />
        <Metric icon={<WarningCircle />} label={t('kubecode.teamNeedsAttention')} name="attention" value={summary.needs_attention} />
        <Metric icon={<CheckCircle />} label={t('kubecode.teamDone')} name="done" value={summary.done} />
      </div>

      {attention.length > 0 && (
        <section className="kubecode-team-attention">
          <header><WarningCircle weight="fill" /> {t('kubecode.teamNeedsAttention')}</header>
          <div>
            {attention.map((attentionItem) => {
              const userRequest = snapshot.user_input_requests?.find(
                (request) => request.id === attentionItem.id,
              )
              if (userRequest) {
                return (
                  <article className="kubecode-team-user-input" key={attentionItem.id}>
                    <div>
                      <strong>{userRequest.title}</strong>
                      <span>{userRequest.prompt}</span>
                    </div>
                    <Textarea
                      aria-label={userRequest.title}
                      placeholder={t('kubecode.teamAnswerPlaceholder')}
                      value={answers[userRequest.id] ?? ''}
                      onChange={(event) => setAnswers((current) => ({
                        ...current,
                        [userRequest.id]: event.target.value,
                      }))}
                    />
                    <Button
                      disabled={!answers[userRequest.id]?.trim()}
                      size="sm"
                      onClick={() => void resolveUserInput(userRequest.id)}
                    >
                      {t('kubecode.teamSubmitAnswer')}
                    </Button>
                  </article>
                )
              }
              return (
                <Button
                  key={attentionItem.id}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const member = snapshot.members.find((candidate) => candidate.id === attentionItem.member_id)
                    if (member) onSelectMember(member.conversation_id)
                  }}
                >
                  <span>{attentionItem.summary}</span>
                  <ArrowRight />
                </Button>
              )
            })}
          </div>
        </section>
      )}
    </>
  )
}

function teamStatusLabel(status: TeamSnapshot['team']['status'], t: Translator): string {
  const keys = {
    draft: 'kubecode.teamStatusDraft',
    starting: 'kubecode.teamStatusStarting',
    active: 'kubecode.teamStatusActive',
    paused: 'kubecode.teamStatusPaused',
    verifying: 'kubecode.teamStatusVerifying',
    needs_attention: 'kubecode.teamNeedsAttention',
    completed: 'kubecode.teamStatusCompleted',
    archived: 'kubecode.teamStatusArchived',
    disbanding: 'kubecode.teamStatusDisbanding',
    removed: 'kubecode.teamStatusRemoved',
  } as const satisfies Record<TeamSnapshot['team']['status'], TranslationKey>
  return t(keys[status] ?? keys.active)
}

function Metric({ icon, label, name, value }: {
  icon: ReactNode
  label: string
  name: string
  value: number
}) {
  return <div data-metric={name}>{icon}<span><strong>{value}</strong><small>{label}</small></span></div>
}
