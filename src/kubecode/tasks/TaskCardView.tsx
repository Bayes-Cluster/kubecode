import { useState } from 'react'

import { AgxBoardCard, AgxProgressRing } from '@/components/agent-ui'
import { MemberAvatar } from '@/components/workspace/MemberIdentity'
import { ChevronRight } from 'lucide-react'
import type { Translator } from '@/lib/i18n'

import type { TaskCard, TaskEventNote } from '../api'
import { progressOf, requiredActionOf } from './taskLifecycle'
import { taskTime } from './taskLabels'
import { TaskStatusBadges } from './TaskStatusBadges'

const EVENT_KEYS = {
  admitted: 'kubecode.task.event.admitted',
  execution_authorized: 'kubecode.task.event.execution_authorized',
  review_requested: 'kubecode.task.event.review_requested',
  review_returned: 'kubecode.task.event.review_returned',
  review_accepted: 'kubecode.task.event.review_accepted',
} as const

function eventLabel(t: Translator, event: TaskEventNote, locale?: string): string | null {
  if (!(event.kind in EVENT_KEYS)) return null
  return t('kubecode.task.event.at', {
    event: t(EVENT_KEYS[event.kind as keyof typeof EVENT_KEYS]),
    time: taskTime(event.created_at, locale),
  })
}

/**
 * One Task on the board, on the shared board shell and the affectUI
 * "Project Card" presentation (ADR 0257, #283): the compact summary — title,
 * what the Task asks of the researcher, the derived progress ring — with the
 * participants and the latest event in a detail fold. The fold opens by
 * click, tap, and keyboard alike (a real disclosure button, no hover);
 * opening the Task itself stays the card's first button, exactly as before.
 * Progress derives from the work rollup — never an estimate.
 */
export function TaskCardView({ card, locale, onOpen, selected, t }: {
  card: TaskCard
  selected: boolean
  t: Translator
  locale?: string
  onOpen: () => void
}) {
  const specialists = card.participants.filter((member) => member.role !== 'general')
  const progress = progressOf(card.work)
  const event = card.last_event ? eventLabel(t, card.last_event, locale) : null
  const [expanded, setExpanded] = useState(false)
  const detailId = `task-card-detail-${card.id}`
  const detail = (
    <>
      {specialists.length > 0 && (
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {specialists.map((member) => (
            <span className="inline-flex items-center gap-1" key={member.member_id}>
              <MemberAvatar name={member.name} role="specialist" size="sm" />
              {member.name}
            </span>
          ))}
        </span>
      )}
      <span className="text-xs text-muted-foreground">
        {progress ? t('kubecode.task.card.progress', progress) : t('kubecode.task.card.noWork')}
      </span>
      {event && <span className="text-xs text-muted-foreground">{event}</span>}
    </>
  )
  return (
    <AgxBoardCard data-needs-you={requiredActionOf(card) !== null || undefined}>
      <div className="flex w-full min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {progress && (
            <AgxProgressRing
              done={progress.done}
              total={progress.total}
              label={t('kubecode.task.card.progress', progress)}
            />
          )}
          <button
            aria-current={selected ? 'true' : undefined}
            className="min-w-0 flex-1 text-left text-sm leading-snug font-semibold [overflow-wrap:anywhere] outline-none rounded-[inherit] focus-visible:ring-[3px] focus-visible:ring-ring aria-[current=true]:ring-2 aria-[current=true]:ring-primary"
            data-focus-key={`card:${card.id}`}
            data-scroll-anchor={`card:${card.id}`}
            data-testid={`task-card-${card.id}`}
            type="button"
            onClick={onOpen}
          >
            {card.title}
          </button>
          {(specialists.length > 0 || event || progress) && (
            <button
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={t('kubecode.task.card.detail')}
              className="flex-none rounded-md p-1 text-muted-foreground outline-none transition-transform duration-200 focus-visible:ring-[3px] focus-visible:ring-ring aria-expanded:rotate-90 hover:bg-accent"
              data-testid={`task-card-toggle-${card.id}`}
              type="button"
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronRight aria-hidden size={16} />
            </button>
          )}
        </div>
        <TaskStatusBadges compact t={t} task={card} />
        {expanded && (
          <span className="flex flex-col items-start gap-2 text-xs" id={detailId} data-testid={`task-open-detail-${card.id}`}>
            {detail}
          </span>
        )}
      </div>
    </AgxBoardCard>
  )
}
