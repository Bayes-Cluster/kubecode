import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { SubagentEntry } from './conversationReducer'

/**
 * Inline subagent bubble in the parent transcript (#108), driven purely by
 * the agent-agnostic envelope: auto-open while `running`, auto-collapse when
 * `completed` unless the user toggled.
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
  const statusLabel = entry.status === 'running'
    ? t('kubecode.subagentRunning')
    : t('kubecode.subagentDone')
  const title = entry.name || entry.prompt || t('kubecode.subagentFallbackName')

  return (
    <div
      className="mb-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
      data-status={entry.status}
      data-testid="subagent-bubble"
    >
      <Button
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-1 text-left"
        data-testid="subagent-bubble-toggle"
        onClick={() => setUserToggled(!open)}
        size="sm"
        variant="ghost"
      >
        <span className="min-w-0 truncate text-sm font-medium">
          {t('kubecode.subagentBubbleTitle', { name: title })}
        </span>
        <span
          className="shrink-0 text-xs text-muted-foreground"
          data-testid="subagent-bubble-status"
        >
          {statusLabel}
        </span>
      </Button>
      {open && (
        <div className="flex flex-col gap-1 pt-1">
          {entry.prompt && (
            <p className="px-1 text-xs text-muted-foreground">{entry.prompt}</p>
          )}
          {entry.events.map((subEvent, index) => (
            <div
              className="px-1 text-xs"
              data-testid="subagent-bubble-event"
              key={`${subEvent.seq}-${index}`}
            >
              <span className="font-medium">{textOf(subEvent)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function textOf(subEvent: { kind: string; payload: Record<string, unknown> }): string {
  const text = subEvent.payload.text
  if (typeof text === 'string' && text) return text
  return subEvent.kind
}
