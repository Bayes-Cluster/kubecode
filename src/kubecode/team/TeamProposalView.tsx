import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import type { TeamProposal } from '../api'
import type { Translator } from '@/lib/i18n'

export function TeamProposalView({ busyAction, onResolve, proposal, t }: {
  busyAction: string | null
  onResolve: (decision: 'approved' | 'rejected') => void
  proposal: TeamProposal
  t: Translator
}) {
  const names = proposalMemberNames(proposal.members_json)
  return (
    <Card className="kubecode-team-proposal" data-testid="team-lineup-proposal">
      <CardHeader>
        <CardTitle>{t('kubecode.teamProposalTitle')}</CardTitle>
        <CardDescription>{proposal.summary}</CardDescription>
      </CardHeader>
      {names.length > 0 && (
        <CardContent className="flex flex-wrap gap-1.5">
          {names.map((name) => <Badge key={name} variant="outline">{name}</Badge>)}
        </CardContent>
      )}
      <CardFooter className="flex-wrap justify-end gap-2">
        <Button
          disabled={busyAction !== null}
          size="sm"
          variant="outline"
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
      </CardFooter>
    </Card>
  )
}

function proposalMemberNames(membersJson: string): string[] {
  try {
    const parsed = JSON.parse(membersJson) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
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
  } catch {
    return []
  }
}
