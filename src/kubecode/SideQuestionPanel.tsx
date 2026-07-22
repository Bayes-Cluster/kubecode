import { CaretDown, CaretUp, ChatCircleDots, CircleNotch, Copy } from '@phosphor-icons/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { TranslationKey } from '@/lib/i18n'

export type SideQuestionItem = {
  answer?: string
  error?: string
  id: string
  question: string
  runId: string
  status: 'completed' | 'failed' | 'pending'
}

export function SideQuestionPanel({
  items,
  t,
}: {
  items: SideQuestionItem[]
  t: (key: TranslationKey) => string
}) {
  const [collapsed, setCollapsed] = useState(false)
  if (items.length === 0) return null

  return (
    <section className="border-t border-border bg-muted/30" data-testid="side-question-panel">
      <Button
        aria-expanded={!collapsed}
        className="h-9 w-full justify-between rounded-none px-4 text-muted-foreground"
        onClick={() => setCollapsed((current) => !current)}
        type="button"
        variant="ghost"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChatCircleDots className="shrink-0" />
          <span className="truncate">{t('kubecode.sideQuestions')}</span>
          <span className="text-xs tabular-nums">{items.length}</span>
        </span>
        {collapsed ? <CaretUp /> : <CaretDown />}
      </Button>
      {!collapsed && (
        <div className="max-h-[40vh] space-y-4 overflow-y-auto border-t border-border px-4 py-3">
          {items.map((item) => (
            <article className="space-y-1.5 text-sm" key={item.id}>
              <p className="select-text font-medium leading-5 text-foreground">{item.question}</p>
              {item.status === 'pending' && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CircleNotch className="animate-spin" />
                  {t('kubecode.sideQuestionPending')}
                </span>
              )}
              {item.answer && (
                <div className="group flex items-start gap-2">
                  <p className="min-w-0 flex-1 select-text whitespace-pre-wrap leading-5 text-muted-foreground">
                    {item.answer}
                  </p>
                  <Button
                    aria-label={t('kubecode.copySideQuestionAnswer')}
                    className="h-7 w-7 shrink-0 opacity-70 group-hover:opacity-100"
                    onClick={() => void navigator.clipboard.writeText(item.answer ?? '')}
                    size="icon-xs"
                    title={t('kubecode.copySideQuestionAnswer')}
                    type="button"
                    variant="ghost"
                  >
                    <Copy />
                  </Button>
                </div>
              )}
              {item.error && (
                <p className="select-text leading-5 text-destructive">
                  {t('kubecode.sideQuestionFailed')}: {item.error}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
