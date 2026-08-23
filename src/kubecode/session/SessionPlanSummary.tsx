import { ChevronRight, ListChecks } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

export type { SessionPlanEntry } from './sessionModel'

type SessionPlanSummaryProps = {
  completedEntries: number
  onOpenPlan?: () => void
  t: Translator
  totalEntries: number
}

export function SessionPlanSummary({
  completedEntries,
  onOpenPlan,
  t,
  totalEntries,
}: SessionPlanSummaryProps) {
  return (
    <div className="kubecode-session-plan">
      <Button
        aria-label={t('kubecode.showAgentPlan')}
        className="kubecode-session-plan-trigger"
        size="sm"
        variant="ghost"
        onClick={onOpenPlan}
      >
        <ListChecks  size={16}/>
        <span>{t('kubecode.agentPlan')}</span>
        <span>{completedEntries} / {totalEntries}</span>
        <ChevronRight  size={16}/>
      </Button>
    </div>
  )
}
