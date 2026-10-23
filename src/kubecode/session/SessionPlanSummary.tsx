import { ChevronRight } from 'lucide-react'

import {
  Plan,
  PlanAction,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from '@/components/ai-elements/plan'
import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

export type { SessionPlanEntry } from './sessionModel'

type SessionPlanSummaryProps = {
  completedEntries: number
  onOpenPlan?: () => void
  t: Translator
  totalEntries: number
}

/**
 * The Agent plan above the composer, on the official Plan card (ADR 0245):
 * its title and progress, and one action that opens the full plan.
 */
export function SessionPlanSummary({
  completedEntries,
  onOpenPlan,
  t,
  totalEntries,
}: SessionPlanSummaryProps) {
  return (
    <Plan className="kubecode-session-plan" data-testid="session-plan-summary">
      <PlanHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PlanTitle>{t('kubecode.agentPlan')}</PlanTitle>
          <PlanDescription className="tabular-nums">
            {t('kubecode.session.planProgress', { completed: completedEntries, total: totalEntries })}
          </PlanDescription>
        </div>
        <PlanAction>
          <Button
            aria-label={t('kubecode.showAgentPlan')}
            size="icon-sm"
            title={t('kubecode.showAgentPlan')}
            type="button"
            variant="ghost"
            onClick={onOpenPlan}
          >
            <ChevronRight aria-hidden />
          </Button>
        </PlanAction>
      </PlanHeader>
    </Plan>
  )
}
