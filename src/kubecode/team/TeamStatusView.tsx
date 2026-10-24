import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Clock,
  LoaderCircle,
  Pause,
  Play,
  Users,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { Textarea } from '@/components/ui/textarea'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { KubecodeApi, TeamSnapshot } from '../api'
import { TEAM_STATUS_ICONS } from '../icons/statusIcons'
import { SystemMessageNotice } from '../SystemMessageNotice'
import { statusToneVariant, type StatusTone } from '../statusTone'

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

  const statusEntry = TEAM_STATUS_ICONS[snapshot.team.status] ?? TEAM_STATUS_ICONS.active
  const StatusIcon = statusEntry.Icon
  return (
    <>
      <header className="kubecode-team-control-header">
        <div className="flex min-w-0 items-start gap-2">
          <Users aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-sm font-medium">{snapshot.team.title || snapshot.leader_conversation.title}</h2>
            <p className="text-xs text-muted-foreground">{t('kubecode.teamControlCenter')}</p>
          </div>
        </div>
        <div className="kubecode-team-settings">
          <Badge variant={statusToneVariant(teamStatusTone(snapshot.team.status))}>
            <StatusIcon aria-hidden="true" />
            {teamStatusLabel(snapshot.team.status, t)}
          </Badge>
          <Badge data-mode={snapshot.team.mode} variant={snapshot.team.mode === 'yolo' ? 'warning' : 'outline'}>
            {snapshot.team.mode === 'yolo' ? t('kubecode.teamYolo') : t('kubecode.teamStandard')}
          </Badge>
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
              <Play data-icon="inline-start" /> {t('kubecode.teamResume')}
            </Button>
          ) : ['active', 'verifying', 'needs_attention'].includes(snapshot.team.status) ? (
            <Button
              disabled={busyAction !== null}
              size="sm"
              variant="outline"
              onClick={onPause}
            >
              <Pause data-icon="inline-start" /> {t('kubecode.teamPause')}
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

      <ItemGroup className="kubecode-team-metrics">
        <Metric icon={<LoaderCircle />} label={t('kubecode.teamRunning')} name="running" value={summary.running} />
        <Metric icon={<Clock />} label={t('kubecode.teamQueued')} name="queued" value={summary.queued} />
        <Metric icon={<CircleAlert />} label={t('kubecode.teamNeedsAttention')} name="attention" value={summary.needs_attention} />
        <Metric icon={<CircleCheck />} label={t('kubecode.teamDone')} name="done" value={summary.done} />
      </ItemGroup>

      {attention.length > 0 && (
        <section aria-labelledby="team-attention-title" className="kubecode-team-attention flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium" id="team-attention-title">
            <CircleAlert aria-hidden="true" className="size-4" />
            {t('kubecode.teamNeedsAttention')}
          </h3>
          <ItemGroup className="gap-1">
            {attention.map((attentionItem) => {
              const userRequest = snapshot.user_input_requests?.find(
                (request) => request.id === attentionItem.id,
              )
              if (userRequest) {
                const fieldId = `team-user-input-${userRequest.id}`
                return (
                  <Item className="kubecode-team-user-input" key={attentionItem.id} variant="outline">
                    <ItemContent>
                      <Field>
                        <FieldLabel htmlFor={fieldId}>{userRequest.title}</FieldLabel>
                        <FieldDescription>{userRequest.prompt}</FieldDescription>
                        <Textarea
                          id={fieldId}
                          placeholder={t('kubecode.teamAnswerPlaceholder')}
                          value={answers[userRequest.id] ?? ''}
                          onChange={(event) => setAnswers((current) => ({
                            ...current,
                            [userRequest.id]: event.target.value,
                          }))}
                        />
                      </Field>
                    </ItemContent>
                    <ItemFooter className="justify-end">
                      <Button
                        disabled={!answers[userRequest.id]?.trim()}
                        size="sm"
                        onClick={() => void resolveUserInput(userRequest.id)}
                      >
                        {t('kubecode.teamSubmitAnswer')}
                      </Button>
                    </ItemFooter>
                  </Item>
                )
              }
              return (
                <Item asChild key={attentionItem.id} size="sm" variant="outline">
                  <button
                    type="button"
                    onClick={() => {
                      const member = snapshot.members.find((candidate) => candidate.id === attentionItem.member_id)
                      if (member) onSelectMember(member.conversation_id)
                    }}
                  >
                    <ItemContent>
                      <ItemTitle>{attentionItem.summary}</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </ItemActions>
                  </button>
                </Item>
              )
            })}
          </ItemGroup>
        </section>
      )}
    </>
  )
}

function teamStatusTone(status: TeamSnapshot['team']['status']): StatusTone {
  if (status === 'active' || status === 'starting' || status === 'verifying') return 'info'
  if (status === 'needs_attention') return 'warn'
  if (status === 'completed') return 'ok'
  return 'muted'
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
  return (
    <Item data-metric={name} size="sm" variant="outline">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle className="tabular-nums">{value}</ItemTitle>
        <ItemDescription>{label}</ItemDescription>
      </ItemContent>
    </Item>
  )
}
