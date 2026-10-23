import { CircleCheck } from 'lucide-react'

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item'
import { StatusBadge, type StatusTone } from '@/components/workspace/StatusBadge'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type { TeamDiscriminationRound } from '../api'

const ROUND_LABELS = {
  error: 'kubecode.teamVerificationStatus.error',
  passed: 'kubecode.teamVerificationStatus.passed',
  rejected: 'kubecode.teamVerificationStatus.rejected',
  running: 'kubecode.teamVerificationStatus.running',
} as const satisfies Record<TeamDiscriminationRound['status'], TranslationKey>

const ROUND_TONES: Record<TeamDiscriminationRound['status'], StatusTone> = {
  error: 'danger',
  passed: 'ok',
  rejected: 'danger',
  running: 'info',
}

export function TeamVerificationView({ rounds, t }: {
  rounds: TeamDiscriminationRound[]
  t: Translator
}) {
  if (rounds.length === 0) return null
  return (
    <section aria-labelledby="team-verification-title" className="kubecode-team-verification flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium" id="team-verification-title">
        <CircleCheck aria-hidden="true" className="size-4" />
        {t('kubecode.teamVerification')}
      </h3>
      <ItemGroup className="gap-1">
        {rounds.map((round) => (
          <Item data-status={round.status} key={round.id} size="sm" variant="outline">
            <ItemContent>
              <ItemTitle>{t('kubecode.teamVerificationRound')} {round.round}</ItemTitle>
              {round.verdict && <ItemDescription>{round.verdict}</ItemDescription>}
            </ItemContent>
            <ItemActions>
              <StatusBadge tone={ROUND_TONES[round.status]}>
                {t(ROUND_LABELS[round.status])}
              </StatusBadge>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  )
}
