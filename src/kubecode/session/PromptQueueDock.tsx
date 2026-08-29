import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Translator } from '@/lib/i18n'

import type { PromptQueueItem } from '../api'

/**
 * Queue surface above the composer (#96): everything the user typed while
 * the agent was busy, editable and removable in place. State converges from
 * `prompt_queue` snapshot events alone — the dock never reorders locally.
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
  onSendNow: (itemId: string) => void
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
    <div
      className="mb-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
      data-testid="prompt-queue"
    >
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t('kubecode.queueTitle', { count: items.length })}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li
            className="flex items-center gap-2 rounded-md px-1 py-0.5"
            data-testid="prompt-queue-row"
            key={item.id}
          >
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {index + 1}.
            </span>
            {editingId === item.id ? (
              <>
                <Input
                  aria-label={t('kubecode.queueEdit')}
                  className="h-7 text-sm"
                  data-testid="prompt-queue-input"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitEdit()
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  value={draft}
                />
                <Button
                  aria-label={t('kubecode.queueSave')}
                  data-testid="prompt-queue-save"
                  disabled={draft.trim().length === 0}
                  onClick={commitEdit}
                  size="sm"
                  variant="ghost"
                >
                  {t('kubecode.queueSave')}
                </Button>
                <Button
                  aria-label={t('kubecode.queueCancelEditing')}
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
                <span
                  className="min-w-0 flex-1 truncate text-sm"
                  title={item.content}
                >
                  {item.content}
                </span>
                <Button
                  aria-label={t('kubecode.queueSendNow')}
                  data-testid="prompt-queue-send-now"
                  onClick={() => onSendNow(item.id)}
                  size="icon-sm"
                  variant="ghost"
                >
                  ⚡
                </Button>
                <Button
                  aria-label={t('kubecode.queueEdit')}
                  data-testid="prompt-queue-edit"
                  onClick={() => beginEdit(item)}
                  size="icon-sm"
                  variant="ghost"
                >
                  ✎
                </Button>
                <Button
                  aria-label={t('kubecode.queueRemove')}
                  data-testid="prompt-queue-remove"
                  onClick={() => onRemove(item.id)}
                  size="icon-sm"
                  variant="ghost"
                >
                  ✕
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
