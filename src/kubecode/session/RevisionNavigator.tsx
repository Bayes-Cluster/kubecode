import { CaretLeft, CaretRight } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'

import type { Translator } from './sessionModel'

type RevisionNavigatorProps = {
  activeIndex: number
  onSelect: (index: number) => void
  t: Translator
  total: number
}

export function RevisionNavigator({
  activeIndex,
  onSelect,
  t,
  total,
}: RevisionNavigatorProps) {
  return (
    <div className="kubecode-revision-navigator">
      <Button
        aria-label={t('kubecode.previousRevision')}
        disabled={activeIndex <= 0}
        size="icon-xs"
        variant="ghost"
        onClick={() => onSelect(activeIndex - 1)}
      >
        <CaretLeft />
      </Button>
      <span>{t('kubecode.revisionPosition', {
        current: activeIndex + 1,
        total,
      })}</span>
      <Button
        aria-label={t('kubecode.nextRevision')}
        disabled={activeIndex >= total - 1}
        size="icon-xs"
        variant="ghost"
        onClick={() => onSelect(activeIndex + 1)}
      >
        <CaretRight />
      </Button>
    </div>
  )
}
