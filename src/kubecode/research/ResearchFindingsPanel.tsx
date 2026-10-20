import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type {
  KubecodeApi,
  ResearchDetail,
  ResearchFinding,
  ResearchFindingKind,
  ResearchOutcome,
  ResearchProposal,
  ResearchRound,
} from '../api'
import { newClientMessageId } from '../session/sessionModel'
import { authorLabel, findingKindLabel, sourceKindLabel } from './researchLabels'
import { AvailabilityBadge, StaleBadge } from './SourceBadge'
import { useAction } from './useAction'

const FINDING_KINDS: ResearchFindingKind[] = ['finding', 'attempt', 'limitation', 'open_question']

export function ResearchFindingsPanel({
  api,
  detail,
  findings,
  onChanged,
  outcomes,
  proposals,
  rounds,
  t,
}: {
  api: KubecodeApi
  detail: ResearchDetail
  findings: ResearchFinding[]
  onChanged: () => void
  outcomes: ResearchOutcome[]
  proposals: ResearchProposal[]
  rounds: ResearchRound[]
  t: Translator
}) {
  const pendingProposals = proposals.filter((proposal) => !proposal.review)
  const decidedProposals = proposals.filter((proposal) => proposal.review)
  const pendingOutcomes = outcomes.filter((outcome) => outcome.status === 'pending')
  const review = useAction(t)
  const [deciding, setDeciding] = useState<string | null>(null)
  const decline = useAction(t)
  const roundNumber = (roundId: string | null) => rounds.find((round) => round.id === roundId)?.round ?? null

  return (
    <div className="kubecode-research-panel">
      {pendingProposals.length > 0 && (
        <section className="kubecode-research-section" aria-label={t('kubecode.research.suggestedChanges')}>
          <h3>{t('kubecode.research.suggestedChanges')}</h3>
          <p className="kubecode-research-muted">{t('kubecode.research.proposalHint')}</p>
          <ul className="kubecode-research-cards">
            {pendingProposals.map((proposal) => {
              // Agreeing or declining is a researcher decision (ADR 0227), named
              // apart from accepting a Task's results.
              const decide = (decision: 'accepted' | 'rejected') => {
                setDeciding(`${proposal.entry.id}:${decision}`)
                void review.run(async () => {
                  try {
                    await api.reviewResearchProposal(detail.project_id, detail.id, proposal.entry.id, decision)
                    onChanged()
                  } finally {
                    setDeciding(null)
                  }
                })
              }
              const held = review.busy ? t('kubecode.task.blocked.deciding') : undefined
              return (
                <li data-focus-key={`suggestion:${proposal.entry.id}`} key={proposal.entry.id} tabIndex={-1}>
                  <p>{proposal.entry.body}</p>
                  <span className="kubecode-research-muted">
                    {authorLabel(t, proposal.entry.author_kind)} · {t('kubecode.research.revisionShort', { revision: proposal.entry.brief_revision })}
                  </span>
                  {!detail.archived && (
                    <div aria-label={proposal.entry.body.slice(0, 60)} className="kubecode-research-row" role="group">
                      <DecisionButton
                        busy={deciding === `${proposal.entry.id}:accepted`}
                        disabledReason={deciding === `${proposal.entry.id}:accepted` ? undefined : held}
                        variant="primary"
                        onDecide={() => decide('accepted')}
                      >
                        {t('kubecode.research.agree')}
                      </DecisionButton>
                      <DecisionButton
                        busy={deciding === `${proposal.entry.id}:rejected`}
                        disabledReason={deciding === `${proposal.entry.id}:rejected` ? undefined : held}
                        variant="secondary"
                        onDecide={() => decide('rejected')}
                      >
                        {t('kubecode.research.decline')}
                      </DecisionButton>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {review.error && <p className="kubecode-research-error" role="alert">{review.error}</p>}
        </section>
      )}

      {pendingOutcomes.length > 0 && (
        <section className="kubecode-research-section" aria-label={t('kubecode.research.pendingOutcomes')}>
          <h3>{t('kubecode.research.pendingOutcomes')}</h3>
          <ul className="kubecode-research-cards">
            {pendingOutcomes.map((outcome) => {
              const link = detail.links.find((item) => item.ref_id === outcome.team_id)
              return (
                <li key={outcome.team_id}>
                  <p>{t('kubecode.research.outcomePending', { team: link?.title || outcome.team_id })}</p>
                  {!detail.archived && (
                    <Button
                      disabled={decline.busy}
                      size="xs"
                      variant="outline"
                      onClick={() => void decline.run(async () => {
                        await api.declineResearchOutcome(detail.project_id, detail.id, outcome.team_id)
                        onChanged()
                      })}
                    >
                      {t('kubecode.research.nothingToRecord')}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
          {decline.error && <p className="kubecode-research-error" role="alert">{decline.error}</p>}
        </section>
      )}

      <section className="kubecode-research-section">
        <h3>{t('kubecode.research.findings')}</h3>
        {findings.length === 0 && <p className="kubecode-research-muted">{t('kubecode.research.noFindings')}</p>}
        <ul className="kubecode-research-cards">
          {findings.map((finding) => (
            <li key={finding.id} data-basis={finding.basis}>
              <header>
                <StatusBadge tone="muted">{findingKindLabel(t, finding.kind)}</StatusBadge>
                <StatusBadge
                  tone={finding.basis === 'observation' ? 'ok' : 'warn'}
                  title={finding.basis === 'interpretation' ? t('kubecode.research.interpretationHint') : undefined}
                >
                  {finding.basis === 'observation'
                    ? t('kubecode.research.basis.observation')
                    : t('kubecode.research.basis.interpretation')}
                </StatusBadge>
                {finding.stale && <StaleBadge t={t} />}
              </header>
              <p>{finding.statement}</p>
              <span className="kubecode-research-muted">
                {authorLabel(t, finding.author_kind)}
                {' · '}
                {t('kubecode.research.revisionShort', { revision: finding.brief_revision })}
                {roundNumber(finding.round_id) !== null && ` · ${t('kubecode.research.roundShort', { round: roundNumber(finding.round_id)! })}`}
              </span>
              {finding.producer_state.length > 0 && (
                <ul className="kubecode-research-sources" aria-label={t('kubecode.research.producedBy')}>
                  {finding.producer_state.map((source) => (
                    <li key={`${source.kind}:${source.id}`}>
                      <span>{t('kubecode.research.producedByItem', { kind: sourceKindLabel(t, source.kind) })}</span>
                      <AvailabilityBadge availability={source.availability} t={t} />
                    </li>
                  ))}
                </ul>
              )}
              {finding.evidence_state.length > 0 && (
                <ul className="kubecode-research-sources" aria-label={t('kubecode.research.evidence')}>
                  {finding.evidence_state.map((source) => (
                    <li key={`${source.kind}:${source.id}`}>
                      <span>{sourceKindLabel(t, source.kind)}</span>
                      <code>{source.id}</code>
                      <AvailabilityBadge availability={source.availability} t={t} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      {!detail.archived && (
        <CaptureForm api={api} detail={detail} onChanged={onChanged} t={t} />
      )}

      {decidedProposals.length > 0 && (
        <section className="kubecode-research-section">
          <h3>{t('kubecode.research.decidedProposals')}</h3>
          <ul className="kubecode-research-cards">
            {decidedProposals.map((proposal) => (
              <li key={proposal.entry.id}>
                <p>{proposal.entry.body}</p>
                <StatusBadge tone={proposal.review?.decision === 'accepted' ? 'ok' : 'muted'}>
                  {proposal.review?.decision === 'accepted'
                    ? t('kubecode.research.accepted')
                    : t('kubecode.research.rejected')}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function CaptureForm({
  api,
  detail,
  onChanged,
  t,
}: {
  api: KubecodeApi
  detail: ResearchDetail
  onChanged: () => void
  t: Translator
}) {
  const sources = detail.links.filter((link) => link.availability !== 'removed')
  const [sourceId, setSourceId] = useState('')
  const [kind, setKind] = useState<ResearchFindingKind>('finding')
  const [statement, setStatement] = useState('')
  const [evidence, setEvidence] = useState('')
  const key = useRef(newClientMessageId())
  const capture = useAction(t)
  const source = sources.find((link) => link.ref_id === sourceId) ?? sources[0]

  if (sources.length === 0) {
    return <p className="kubecode-research-muted">{t('kubecode.research.captureNeedsLink')}</p>
  }
  const submit = async () => {
    const text = statement.trim()
    if (!text || !source) return
    const path = evidence.trim()
    const saved = await capture.run(() => api.captureResearchFindings(detail.project_id, detail.id, {
      publication_key: key.current,
      ...(source.kind === 'team' ? { team_id: source.ref_id } : { session_id: source.ref_id }),
      findings: [{
        kind,
        statement: text,
        ...(path ? { evidence: [{ kind: 'file' as const, id: path }] } : {}),
      }],
    }))
    if (saved) {
      key.current = newClientMessageId()
      setStatement('')
      setEvidence('')
      onChanged()
    }
  }

  return (
    <form
      aria-label={t('kubecode.research.capture')}
      className="kubecode-research-section kubecode-research-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <h3>{t('kubecode.research.capture')}</h3>
      <p className="kubecode-research-muted">{t('kubecode.research.captureHint')}</p>
      <div className="kubecode-research-row">
        <Select
          value={source?.ref_id ?? ''}
          onValueChange={(value) => {
            key.current = newClientMessageId()
            setSourceId(value)
          }}
        >
          <SelectTrigger aria-label={t('kubecode.research.captureFrom')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {sources.map((link) => (
              <SelectItem key={link.ref_id} value={link.ref_id}>
                {link.title || link.ref_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={kind}
          onValueChange={(value) => {
            key.current = newClientMessageId()
            setKind(value as ResearchFindingKind)
          }}
        >
          <SelectTrigger aria-label={t('kubecode.research.findingKind')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {FINDING_KINDS.map((item) => (
              <SelectItem key={item} value={item}>{findingKindLabel(t, item)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Textarea
        aria-label={t('kubecode.research.statement')}
        rows={3}
        value={statement}
        maxLength={4000}
        onChange={(event) => {
          key.current = newClientMessageId()
          setStatement(event.target.value)
        }}
      />
      <Input
        aria-label={t('kubecode.research.evidenceFile')}
        placeholder={t('kubecode.research.evidenceFilePlaceholder')}
        value={evidence}
        onChange={(event) => {
          key.current = newClientMessageId()
          setEvidence(event.target.value)
        }}
      />
      {capture.error && <p className="kubecode-research-error" role="alert">{capture.error}</p>}
      <div className="kubecode-research-panel-actions">
        <Button aria-busy={capture.busy} disabled={!statement.trim() || capture.busy} size="sm" type="submit">
          {t('kubecode.research.record')}
        </Button>
      </div>
    </form>
  )
}

