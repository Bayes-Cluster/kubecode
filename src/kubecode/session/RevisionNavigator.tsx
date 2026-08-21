import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

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
        <ChevronLeft  size={16}/>
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
        <ChevronRight  size={16}/>
      </Button>
    </div>
  )
}
