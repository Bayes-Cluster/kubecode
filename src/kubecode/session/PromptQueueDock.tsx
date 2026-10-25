import { useState } from 'react'
import { Pencil, X, Zap } from 'lucide-react'

import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Translator } from '@/lib/i18n'

import type { PromptQueueItem } from '../api'

/**
 * Queue actions are always visible: the element hides them until hover,
 * which leaves them undiscoverable on touch devices and to the keyboard.
 */
const ACTION_CLASS = 'opacity-100'

/**
 * Queue surface above the composer (#96) on the official Queue element
 * (ADR 0245): everything the user typed while the agent was busy, editable
 * and removable in place. State converges from `prompt_queue` snapshot
 * events alone — the dock never reorders locally.
 */
export function PromptQueueDock({
  items,
  onEdit,
  onRemove,
  onSendNow,
  t,
}: {
  items: PromptQueueItem[]
  onEdit: (itemId: string, content: string) => void
  onRemove: (itemId: string) => void
  onSendNow?: (itemId: string) => void
  t: Translator
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  if (items.length === 0) return null

  const beginEdit = (item: PromptQueueItem) => {
    setEditingId(item.id)
    setDraft(item.content)
  }
  const commitEdit = () => {
    if (!editingId) return
    const content = draft.trim()
    if (content) onEdit(editingId, content)
    setEditingId(null)
    setDraft('')
  }

  return (
    <Queue className="kubecode-session-queue" data-testid="prompt-queue">
      <QueueSection>
        <QueueSectionTrigger>
          <QueueSectionLabel label={t('kubecode.queueTitle', { count: items.length })} />
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            {items.map((item) => (
              <QueueItem data-testid="prompt-queue-row" key={item.id}>
                <div className="flex items-center gap-2">
                  <QueueItemIndicator />
                  {editingId === item.id ? (
                    <>
                      <Input
                        aria-label={t('kubecode.queueEdit')}
                        autoFocus
                        className="h-7 min-w-0 flex-1 text-sm"
                        data-testid="prompt-queue-input"
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitEdit()
                          if (event.key === 'Escape') setEditingId(null)
                        }}
                        value={draft}
                      />
                      <Button
                        data-testid="prompt-queue-save"
                        disabled={draft.trim().length === 0}
                        onClick={commitEdit}
                        size="sm"
                        variant="ghost"
                      >
                        {t('kubecode.queueSave')}
                      </Button>
                      <Button
                        data-testid="prompt-queue-cancel"
                        onClick={() => setEditingId(null)}
                        size="sm"
                        variant="ghost"
                      >
                        {t('kubecode.queueCancelEditing')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <QueueItemContent title={item.content}>
                        {item.content}
                      </QueueItemContent>
                      <QueueItemActions>
                        {onSendNow && (
                          <QueueItemAction
                            aria-label={t('kubecode.queueSendNow')}
                            className={ACTION_CLASS}
                            data-testid="prompt-queue-send-now"
                            title={t('kubecode.queueSendNow')}
                            onClick={() => onSendNow(item.id)}
                          >
                            <Zap aria-hidden size={14} />
                          </QueueItemAction>
                        )}
                        <QueueItemAction
                          aria-label={t('kubecode.queueEdit')}
                          className={ACTION_CLASS}
                          data-testid="prompt-queue-edit"
                          title={t('kubecode.queueEdit')}
                          onClick={() => beginEdit(item)}
                        >
                          <Pencil aria-hidden size={14} />
                        </QueueItemAction>
                        <QueueItemAction
                          aria-label={t('kubecode.queueRemove')}
                          className={ACTION_CLASS}
                          data-testid="prompt-queue-remove"
                          title={t('kubecode.queueRemove')}
                          onClick={() => onRemove(item.id)}
                        >
                          <X aria-hidden size={14} />
                        </QueueItemAction>
                      </QueueItemActions>
                    </>
                  )}
                </div>
              </QueueItem>
            ))}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  )
}
