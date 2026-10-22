import { ChevronRight, ListChecks } from 'lucide-react'

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
    <Plan className="kubecode-session-plan" data-testid="session-plan-summary" data-ws-components="official">
      <PlanHeader className="kubecode-session-plan-header">
        <div className="kubecode-session-plan-heading">
          <ListChecks aria-hidden size={16} />
          <PlanTitle className="kubecode-session-plan-title">{t('kubecode.agentPlan')}</PlanTitle>
          <PlanDescription className="kubecode-session-plan-progress">
            {t('kubecode.session.planProgress', { completed: completedEntries, total: totalEntries })}
          </PlanDescription>
        </div>
        <PlanAction>
          <Button
            aria-label={t('kubecode.showAgentPlan')}
            className="kubecode-session-plan-trigger"
            size="icon-sm"
            title={t('kubecode.showAgentPlan')}
            type="button"
            variant="ghost"
            onClick={onOpenPlan}
          >
            <ChevronRight aria-hidden size={16} />
          </Button>
        </PlanAction>
      </PlanHeader>
    </Plan>
  )
}
