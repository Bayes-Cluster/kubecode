import { ChevronDown, Copy, MessageSquareMore } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'

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
  t: Translator
}) {
  const [open, setOpen] = useState(true)
  if (items.length === 0) return null

  return (
    <Collapsible
      className="flex flex-col border-t"
      data-testid="side-question-panel"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger asChild>
        <Button className="w-full justify-between" type="button" variant="ghost">
          <span className="flex min-w-0 items-center gap-2">
            <MessageSquareMore data-icon="inline-start" />
            <span className="truncate">{t('kubecode.sideQuestions')}</span>
            <Badge variant="secondary">{items.length}</Badge>
          </span>
          <ChevronDown className={open ? 'rotate-180' : undefined} data-icon="inline-end" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-[40vh] overflow-y-auto px-2 pb-2">
        <ItemGroup className="gap-1">
          {items.map((item) => (
            <Item key={item.id} size="sm">
              <ItemContent>
                <ItemTitle className="select-text">{item.question}</ItemTitle>
                {item.status === 'pending' && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Spinner />
                    {t('kubecode.sideQuestionPending')}
                  </span>
                )}
                {item.answer && (
                  <p className="select-text whitespace-pre-wrap text-sm text-muted-foreground">
                    {item.answer}
                  </p>
                )}
                {item.error && (
                  <p className="select-text text-sm text-destructive">
                    {t('kubecode.sideQuestionFailed')}: {item.error}
                  </p>
                )}
              </ItemContent>
              {item.answer && (
                <ItemActions>
                  <Button
                    aria-label={t('kubecode.copySideQuestionAnswer')}
                    onClick={() => void navigator.clipboard.writeText(item.answer ?? '')}
                    size="icon-xs"
                    title={t('kubecode.copySideQuestionAnswer')}
                    type="button"
                    variant="ghost"
                  >
                    <Copy />
                  </Button>
                </ItemActions>
              )}
            </Item>
          ))}
        </ItemGroup>
      </CollapsibleContent>
    </Collapsible>
  )
}
