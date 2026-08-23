import { CircleCheck } from 'lucide-react'

import type { TeamDiscriminationRound } from '../api'
import type { Translator } from '@/lib/i18n'

export function TeamVerificationView({ rounds, t }: {
  rounds: TeamDiscriminationRound[]
  t: Translator
}) {
  if (rounds.length === 0) return null
  return (
    <section className="kubecode-team-verification">
      <header><CircleCheck  size={16}/> {t('kubecode.teamVerification')}</header>
      {rounds.map((round) => (
        <div key={round.id} data-status={round.status}>
          <strong>{t('kubecode.teamVerificationRound')} {round.round}</strong>
          <span>{round.status}</span>
          {round.verdict && <p>{round.verdict}</p>}
        </div>
      ))}
    </section>
  )
}
