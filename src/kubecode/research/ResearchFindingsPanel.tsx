import { useId, useRef, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { FieldDescription, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
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
import { authorLabel, availabilityLabel, availabilityVariant, findingKindLabel, sourceKindLabel } from './researchLabels'
import { ResearchPanel, ResearchSection } from './ResearchLayout'
import { useAction } from './useAction'
import { statusToneVariant } from '../statusTone'

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
  const heldId = useId()
  const decline = useAction(t)
  const roundNumber = (roundId: string | null) => rounds.find((round) => round.id === roundId)?.round ?? null

  return (
    <ResearchPanel>
      {pendingProposals.length > 0 && (
        <ResearchSection label={t('kubecode.research.suggestedChanges')} named>
          <p className="m-0 text-sm text-muted-foreground">{t('kubecode.research.proposalHint')}</p>
          <ItemGroup className="gap-2">
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
                <Item data-focus-key={`suggestion:${proposal.entry.id}`} key={proposal.entry.id} role="listitem" size="sm" tabIndex={-1} variant="outline">
                  <ItemContent>
                    <p className="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{proposal.entry.body}</p>
                    <ItemDescription>
                      {authorLabel(t, proposal.entry.author_kind)} · {t('kubecode.research.revisionShort', { revision: proposal.entry.brief_revision })}
                    </ItemDescription>
                  </ItemContent>
                  {!detail.archived && (
                    <ItemActions aria-label={proposal.entry.body.slice(0, 60)} className="flex-wrap" role="group">
                      {(['accepted', 'rejected'] as const).map((verdict) => {
                        const busy = deciding === `${proposal.entry.id}:${verdict}`
                        return (
                          <Button
                            aria-busy={busy || undefined}
                            aria-describedby={held && !busy ? `${heldId}-${proposal.entry.id}` : undefined}
                            aria-disabled={busy || undefined}
                            disabled={Boolean(held) && !busy}
                            key={verdict}
                            size="wrap"
                            variant={verdict === 'accepted' ? 'default' : 'outline'}
                            onClick={busy ? undefined : () => decide(verdict)}
                          >
                            {busy && <Spinner aria-hidden="true" data-icon="inline-start" />}
                            {verdict === 'accepted' ? t('kubecode.research.agree') : t('kubecode.research.decline')}
                          </Button>
                        )
                      })}
                      {held && <FieldDescription className="basis-full" id={`${heldId}-${proposal.entry.id}`}>{held}</FieldDescription>}
                    </ItemActions>
                  )}
                </Item>
              )
            })}
          </ItemGroup>
          {review.error && <Alert variant="destructive"><AlertDescription>{review.error}</AlertDescription></Alert>}
        </ResearchSection>
      )}

      {pendingOutcomes.length > 0 && (
        <ResearchSection label={t('kubecode.research.pendingOutcomes')} named>
          <ItemGroup className="gap-2">
            {pendingOutcomes.map((outcome) => {
              const link = detail.links.find((item) => item.ref_id === outcome.team_id)
              return (
                <Item key={outcome.team_id} role="listitem" size="sm" variant="outline">
                  <ItemContent>
                    <ItemTitle className="font-normal [overflow-wrap:anywhere]">{t('kubecode.research.outcomePending', { team: link?.title || outcome.team_id })}</ItemTitle>
                  </ItemContent>
                  {!detail.archived && (
                    <ItemActions>
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
                    </ItemActions>
                  )}
                </Item>
              )
            })}
          </ItemGroup>
          {decline.error && <Alert variant="destructive"><AlertDescription>{decline.error}</AlertDescription></Alert>}
        </ResearchSection>
      )}

      <ResearchSection label={t('kubecode.research.findings')}>
        {findings.length === 0 && (
          <Empty className="items-start p-0 text-left md:p-0">
            <EmptyDescription>{t('kubecode.research.noFindings')}</EmptyDescription>
          </Empty>
        )}
        <ItemGroup className="gap-2 empty:hidden">
          {findings.map((finding) => (
            <Item key={finding.id} data-basis={finding.basis} role="listitem" size="sm" variant="outline">
              <ItemContent className="gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{findingKindLabel(t, finding.kind)}</Badge>
                <Badge
                  variant={statusToneVariant(finding.basis === 'observation' ? 'ok' : 'warn')}
                  title={finding.basis === 'interpretation' ? t('kubecode.research.interpretationHint') : undefined}
                >
                  {finding.basis === 'observation'
                    ? t('kubecode.research.basis.observation')
                    : t('kubecode.research.basis.interpretation')}
                </Badge>
                {finding.stale && <Badge title={t('kubecode.research.staleHint')} variant="warning">{t('kubecode.research.stale')}</Badge>}
              </div>
              <p className="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{finding.statement}</p>
              <ItemDescription>
                {authorLabel(t, finding.author_kind)}
                {' · '}
                {t('kubecode.research.revisionShort', { revision: finding.brief_revision })}
                {roundNumber(finding.round_id) !== null && ` · ${t('kubecode.research.roundShort', { round: roundNumber(finding.round_id)! })}`}
              </ItemDescription>
              {finding.producer_state.length > 0 && (
                <ul className={SOURCE_LIST} aria-label={t('kubecode.research.producedBy')}>
                  {finding.producer_state.map((source) => (
                    <li className={SOURCE_ROW} key={`${source.kind}:${source.id}`}>
                      <span>{t('kubecode.research.producedByItem', { kind: sourceKindLabel(t, source.kind) })}</span>
                      <Badge variant={availabilityVariant(source.availability)}>{availabilityLabel(t, source.availability)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              {finding.evidence_state.length > 0 && (
                <ul className={SOURCE_LIST} aria-label={t('kubecode.research.evidence')}>
                  {finding.evidence_state.map((source) => (
                    <li className={SOURCE_ROW} key={`${source.kind}:${source.id}`}>
                      <span>{sourceKindLabel(t, source.kind)}</span>
                      <code className="[overflow-wrap:anywhere]">{source.id}</code>
                      <Badge variant={availabilityVariant(source.availability)}>{availabilityLabel(t, source.availability)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </ResearchSection>

      {!detail.archived && (
        <CaptureForm api={api} detail={detail} onChanged={onChanged} t={t} />
      )}

      {decidedProposals.length > 0 && (
        <ResearchSection label={t('kubecode.research.decidedProposals')}>
          <ItemGroup className="gap-2">
            {decidedProposals.map((proposal) => (
              <Item key={proposal.entry.id} role="listitem" size="sm" variant="outline">
                <ItemContent>
                  <p className="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{proposal.entry.body}</p>
                </ItemContent>
                <Badge variant={statusToneVariant(proposal.review?.decision === 'accepted' ? 'ok' : 'muted')}>
                  {proposal.review?.decision === 'accepted'
                    ? t('kubecode.research.accepted')
                    : t('kubecode.research.rejected')}
                </Badge>
              </Item>
            ))}
          </ItemGroup>
        </ResearchSection>
      )}
    </ResearchPanel>
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
    return (
      <Empty className="items-start p-0 text-left md:p-0">
        <EmptyDescription>{t('kubecode.research.captureNeedsLink')}</EmptyDescription>
      </Empty>
    )
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
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <ResearchSection label={t('kubecode.research.capture')}>
        <FieldGroup className="gap-3">
          <FieldDescription>{t('kubecode.research.captureHint')}</FieldDescription>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={source?.ref_id ?? ''}
              onValueChange={(value) => {
                key.current = newClientMessageId()
                setSourceId(value)
              }}
            >
              <SelectTrigger aria-label={t('kubecode.research.captureFrom')} className="min-w-[140px] flex-1 sm:flex-none"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {sources.map((link) => (
                    <SelectItem key={link.ref_id} value={link.ref_id}>
                      {link.title || link.ref_id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={kind}
              onValueChange={(value) => {
                key.current = newClientMessageId()
                setKind(value as ResearchFindingKind)
              }}
            >
              <SelectTrigger aria-label={t('kubecode.research.findingKind')} className="min-w-[140px] flex-1 sm:flex-none"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FINDING_KINDS.map((item) => (
                    <SelectItem key={item} value={item}>{findingKindLabel(t, item)}</SelectItem>
                  ))}
                </SelectGroup>
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
          {capture.error && <Alert variant="destructive"><AlertDescription>{capture.error}</AlertDescription></Alert>}
          <div className="flex justify-end">
            <Button aria-busy={capture.busy} disabled={!statement.trim() || capture.busy} size="sm" type="submit">
              {t('kubecode.research.record')}
            </Button>
          </div>
        </FieldGroup>
      </ResearchSection>
    </form>
  )
}

const SOURCE_LIST = 'm-0 flex list-none flex-col gap-0.5 p-0 text-xs text-muted-foreground'
const SOURCE_ROW = 'flex flex-wrap items-center gap-1.5'
