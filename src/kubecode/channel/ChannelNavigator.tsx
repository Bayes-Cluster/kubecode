import { Hash } from 'lucide-react'

import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { ChannelThread } from '../api'

export type ChannelNavigatorProps = {
  active: boolean
  onOpen: () => void
  /** Open Threads, most recently active first. */
  onOpenThread: (threadId: string) => void
  /** Lists the Threads only: General has its own entry in the Workspace navigation. */
  threadsOnly?: boolean
  t: Translator
  threads: ChannelThread[]
}

/** The Workspace conversation, above the research list and the Sessions. */
export function ChannelNavigator({ active, onOpen, onOpenThread, t, threads, threadsOnly = false }: ChannelNavigatorProps) {
  return (
    <section aria-label={t('kubecode.channel.title')} className="kubecode-channel-nav">
      <div className="kubecode-navigator-tools">
        <span>{t('kubecode.channel.title')}</span>
      </div>
      <ul className="kubecode-research-nav-list">
        {!threadsOnly && (
          <li>
            <button
              aria-current={active ? 'true' : undefined}
              className="kubecode-research-nav-item"
              type="button"
              onClick={onOpen}
            >
              <Hash aria-hidden size={14} />
              <span className="kubecode-research-nav-title">{t('kubecode.channel.general')}</span>
            </button>
          </li>
        )}
        {threads.slice(0, 5).map((thread) => (
          <li key={thread.id}>
            <button
              className="kubecode-research-nav-item kubecode-channel-nav-thread"
              type="button"
              onClick={() => onOpenThread(thread.id)}
            >
              <span className="kubecode-research-nav-title">{thread.title}</span>
              {thread.research_id && (
                <StatusBadge tone="ok">
                  {t('kubecode.channel.linkedBadge')}
                </StatusBadge>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
