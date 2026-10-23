import { Card } from '@/components/ui/card'
import { MemberAvatar } from '@/components/workspace/MemberIdentity'
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
 * One Task on the board: the official Card (#259) holding a single button
 * that opens it, with no control inside. It says what the Task asks of the
 * researcher, its condition, who works on it, how far the work is, and what
 * last happened. The Card owns the surface; the button only lays the lines out
 * and shows focus and the inspected Task as a ring.
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
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <button
        aria-current={selected ? 'true' : undefined}
        className="flex w-full min-w-0 flex-col items-start gap-2 rounded-[inherit] p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=true]:ring-2 aria-[current=true]:ring-primary aria-[current=true]:ring-inset"
        data-focus-key={`card:${card.id}`}
        data-needs-you={requiredActionOf(card) !== null || undefined}
        data-scroll-anchor={`card:${card.id}`}
        data-testid={`task-card-${card.id}`}
        type="button"
        onClick={onOpen}
      >
        <span className="text-sm leading-snug font-semibold [overflow-wrap:anywhere]">{card.title}</span>
        <TaskStatusBadges compact t={t} task={card} />
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
      </button>
    </Card>
  )
}
