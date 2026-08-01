import { CheckCircle } from '@phosphor-icons/react'

import type { TeamDiscriminationRound } from '../api'
import type { Translator } from './types'

export function TeamVerificationView({ rounds, t }: {
  rounds: TeamDiscriminationRound[]
  t: Translator
}) {
  if (rounds.length === 0) return null
  return (
    <section className="kubecode-team-verification">
      <header><CheckCircle /> {t('kubecode.teamVerification')}</header>
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
