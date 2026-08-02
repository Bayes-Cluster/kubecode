import { Button } from '@/components/ui/button'

import type { TeamProposal } from '../api'
import type { Translator } from '@/lib/i18n'

export function TeamProposalView({ busyAction, onResolve, proposal, t }: {
  busyAction: string | null
  onResolve: (decision: 'approved' | 'rejected') => void
  proposal: TeamProposal
  t: Translator
}) {
  return (
    <section className="kubecode-team-proposal" data-testid="team-lineup-proposal">
      <div>
        <strong>{t('kubecode.teamProposalTitle')}</strong>
        <span>{proposal.summary}</span>
        <ProposalMembers membersJson={proposal.members_json} />
      </div>
      <footer>
        <Button
          disabled={busyAction !== null}
          size="sm"
          variant="ghost"
          onClick={() => onResolve('rejected')}
        >
          {t('kubecode.teamProposalReject')}
        </Button>
        <Button
          disabled={busyAction !== null}
          size="sm"
          onClick={() => onResolve('approved')}
        >
          {t('kubecode.teamProposalApprove')}
        </Button>
      </footer>
    </section>
  )
}

function ProposalMembers({ membersJson }: { membersJson: string }) {
  let names: string[] = []
  try {
    const parsed = JSON.parse(membersJson) as unknown
    if (Array.isArray(parsed)) {
      names = parsed.flatMap((value) => {
        if (typeof value === 'string') return [value]
        if (!value || typeof value !== 'object') return []
        const member = value as Record<string, unknown>
        const name = typeof member.name === 'string'
          ? member.name
          : typeof member.role === 'string'
            ? member.role
            : null
        return name ? [name] : []
      })
    }
  } catch {
    names = []
  }
  if (names.length === 0) return null
  return <div className="kubecode-team-proposal-members">{names.map((name) => <span key={name}>{name}</span>)}</div>
}
