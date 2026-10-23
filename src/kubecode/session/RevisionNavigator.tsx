import { ChevronLeft, ChevronRight, History } from 'lucide-react'

import { Checkpoint, CheckpointIcon } from '@/components/ai-elements/checkpoint'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group'
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
  const position = t('kubecode.revisionPosition', {
    current: activeIndex + 1,
    total,
  })
  return (
    <ButtonGroup aria-label={position} className="kubecode-revision-navigator">
      <Button
        aria-label={t('kubecode.previousRevision')}
        disabled={activeIndex <= 0}
        size="icon-sm"
        variant="outline"
        onClick={() => onSelect(activeIndex - 1)}
      >
        <ChevronLeft />
      </Button>
      <ButtonGroupText aria-hidden="true">{position}</ButtonGroupText>
      <Button
        aria-label={t('kubecode.nextRevision')}
        disabled={activeIndex >= total - 1}
        size="icon-sm"
        variant="outline"
        onClick={() => onSelect(activeIndex + 1)}
      >
        <ChevronRight />
      </Button>
    </ButtonGroup>
  )
}

export function RecreatedContextCheckpoint({ label }: { label: string }) {
  return (
    <Checkpoint className="kubecode-recreated-context" role="note">
      <CheckpointIcon><History aria-hidden="true" className="size-4 shrink-0" /></CheckpointIcon>
      <span className="shrink-0 text-xs">{label}</span>
    </Checkpoint>
  )
}
