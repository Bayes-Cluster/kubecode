import { useState } from 'react'
import { Bot, ChevronDown } from 'lucide-react'

import { Shimmer } from '@/components/ai-elements/shimmer'
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from '@/components/ai-elements/task'
import { Badge } from '@/components/ui/badge'
import type { Translator } from '@/lib/i18n'

import type { SubagentEntry } from './conversationReducer'

/**
 * Inline subagent in the parent transcript (#108) on the official Task
 * element (ADR 0245; the Subagent element is not published), driven purely
 * by the agent-agnostic envelope: open while `running`, collapsed once
 * `completed` unless the reader toggled it.
 */
export function SubagentBubble({
  entry,
  t,
}: {
  entry: SubagentEntry
  t: Translator
}) {
  const autoOpen = entry.status === 'running'
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = userToggled ?? autoOpen
  const running = entry.status === 'running'
  const statusLabel = running ? t('kubecode.subagentRunning') : t('kubecode.subagentDone')
  const title = t('kubecode.subagentBubbleTitle', {
    name: entry.name || entry.prompt || t('kubecode.subagentFallbackName'),
  })

  return (
    <Task
      className="kubecode-session-subagent"
      data-status={entry.status}
      data-testid="subagent-bubble"
      data-ws-components="official"
      open={open}
      onOpenChange={setUserToggled}
    >
      <TaskTrigger title={title}>
        <button
          className="kubecode-session-subagent-trigger"
          data-testid="subagent-bubble-toggle"
          type="button"
        >
          <Bot aria-hidden size={14} />
          <span className="min-w-0 flex-1 truncate">
            {running ? <Shimmer as="span" duration={1.5}>{title}</Shimmer> : title}
          </span>
          <Badge data-testid="subagent-bubble-status" variant="secondary">{statusLabel}</Badge>
          <ChevronDown aria-hidden className="kubecode-session-subagent-caret" size={14} />
        </button>
      </TaskTrigger>
      <TaskContent role="group" aria-label={t('kubecode.session.subagentEvents')}>
        {entry.prompt && <TaskItem className="kubecode-session-subagent-prompt">{entry.prompt}</TaskItem>}
        {entry.events.map((subEvent, index) => (
          <TaskItem data-testid="subagent-bubble-event" key={`${subEvent.seq}-${index}`}>
            {textOf(subEvent)}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  )
}

function textOf(subEvent: { kind: string; payload: Record<string, unknown> }): string {
  const text = subEvent.payload.text
  if (typeof text === 'string' && text) return text
  return subEvent.kind
}
