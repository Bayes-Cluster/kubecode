import { ChevronRightIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage } from '../api'
import { REVEAL_ACTIVITY_EVENT } from './activityReveal'
import { messageDate, shortTime } from './timeline'

/**
 * A run of routine Kubecode notes (routing, hand-offs) collapsed into one
 * line until asked for (ADR 0229 §7), on the official Collapsible. Each note
 * stays in the document while closed, so a link or a citation can still land
 * on it; a jump there opens the group first (`revealActivity`).
 */
export function ActivityGroup({ dateLocale, messages, t }: { dateLocale: string; messages: ChannelMessage[]; t: Translator }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = root.current
    if (!node) return
    // Synchronous, so the note is laid out before the jump scrolls to it.
    const reveal = () => flushSync(() => setOpen(true))
    node.addEventListener(REVEAL_ACTIVITY_EVENT, reveal)
    return () => node.removeEventListener(REVEAL_ACTIVITY_EVENT, reveal)
  }, [])
  return (
    <Collapsible className="kubecode-activity-group flex flex-col gap-1 px-2" open={open} ref={root} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button className="group self-start text-muted-foreground" size="xs" variant="ghost">
          <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" data-icon="inline-start" />
          {t('kubecode.channel.activityGroup', { count: messages.length })}
        </Button>
      </CollapsibleTrigger>
      {/* Mounted while closed: its notes are anchors. */}
      <CollapsibleContent forceMount hidden={!open}>
        <ul className="flex list-none flex-col gap-1 ps-3 text-xs text-muted-foreground">
          {messages.map((message) => {
            const date = messageDate(message.created_at)
            return (
              <li
                className="flex flex-wrap gap-2 [overflow-wrap:anywhere]"
                data-author="system"
                data-focus-key={`message:${message.id}`}
                data-message-id={message.id}
                data-scroll-anchor={message.id}
                data-testid={`message-${message.seq}`}
                id={`message-${message.id}`}
                key={message.id}
              >
                <span>{message.body}</span>
                {date && <time dateTime={date.toISOString()}>{shortTime(date, dateLocale)}</time>}
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
