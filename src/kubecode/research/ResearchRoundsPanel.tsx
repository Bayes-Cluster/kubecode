import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  AgentId,
  ExecutionEnvelopeLimits,
  KubecodeApi,
  ResearchDetail,
  ResearchFinding,
  ResearchRound,
  ResearchRoundKind,
  ResearchSourceAvailability,
  ResearchSourceRef,
  ResearchTargetView,
  TeamSnapshot,
  WorkspaceEvent,
} from '../api'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'
import { newClientMessageId } from '../session/sessionModel'
import { ExecutionEnvelopeFields } from './ExecutionEnvelopeFields'
import { defaultEnvelopeDraft, limitsFromDraft, unixNow, type EnvelopeDraft } from './executionEnvelope'
import { ResearchExecutionSection } from './ResearchExecutionSection'
import { agentLabel, phaseLabel, sourceKindLabel } from './researchLabels'
import { AvailabilityBadge, StaleBadge } from './SourceBadge'
import { useAction } from './useAction'

const MAX_CARRIED_SOURCES = 20

type CarryOver = ResearchSourceRef & { availability: ResearchSourceAvailability }

/** Evidence from recorded findings, once each, that a next round could reuse. */
function carryOverCandidates(findings: ResearchFinding[]): CarryOver[] {
  const seen = new Map<string, CarryOver>()
  for (const finding of findings) {
    for (const source of finding.evidence_state) {
      seen.set(`${source.kind}:${source.id}`, source)
    }
  }
  return [...seen.values()]
}

export function ResearchRoundsPanel({
  agents,
  api,
  connectionState,
  detail,
  events,
  findings,
  onChanged,
  onOpenSession,
  rounds,
  t,
  teams,
}: {
  agents: AgentDescriptor[]
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  detail: ResearchDetail
  events: WorkspaceEvent[]
  findings: ResearchFinding[]
  onChanged: () => void
  onOpenSession: (conversationId: string) => void
  rounds: ResearchRound[]
  t: Translator
  teams: TeamSnapshot[]
}) {
  const available = agents.filter((agent) => agent.available)
  const candidates = useMemo(() => carryOverCandidates(findings), [findings])
  const [mode, setMode] = useState<ResearchRoundKind>('team')
  const [agentId, setAgentId] = useState<AgentId | ''>('')
  const [instruction, setInstruction] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  // One key per intended round: retrying after a lost response resumes the
  // same round instead of creating a second one.
  const requestKey = useRef(newClientMessageId())
  const start = useAction(t)
  const resume = useAction(t)
  const [allowExecution, setAllowExecution] = useState(false)
  const [envelope, setEnvelope] = useState<EnvelopeDraft>(defaultEnvelopeDraft)
  const [envelopeInvalid, setEnvelopeInvalid] = useState<Parameters<typeof ExecutionEnvelopeFields>[0]['invalid']>(null)
  // The researcher's explicit choice per round; unset, only the newest is open.
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const selectedAgent = agentId || available[0]?.id || ''
  // The key names one intended round; any change to what is asked starts a
  // new intent, so a retry never reuses a key for a different request.
  const rekey = () => {
    requestKey.current = newClientMessageId()
  }
  const nextRound = (rounds[0]?.round ?? 0) + 1
  const carried = candidates
    .filter((source) => source.availability === 'available' && !excluded.has(`${source.kind}:${source.id}`))
    .slice(0, MAX_CARRIED_SOURCES)

  const leaderConversation = (target: ResearchTargetView | null): string | null => (
    target
      ? teams.find((snapshot) => snapshot.team.id === target.id)?.leader_conversation.id ?? null
      : null
  )

  const startRound = async () => {
    if (!selectedAgent) return
    let limits: ExecutionEnvelopeLimits | undefined
    if (allowExecution) {
      const result = limitsFromDraft(envelope, unixNow())
      if (!result.ok) {
        setEnvelopeInvalid(result.field)
        return
      }
      limits = result.limits
    }
    setEnvelopeInvalid(null)
    const started = await start.run(() => api.startResearchRound(detail.project_id, detail.id, {
      client_request_id: requestKey.current,
      expected_revision: detail.revision,
      mode,
      agent_id: selectedAgent,
      instruction: instruction.trim() || undefined,
      sources: carried.map((source) => ({ kind: source.kind, id: source.id })),
      ...(limits ? { envelope: limits } : {}),
    }))
    if (started) {
      requestKey.current = newClientMessageId()
      setInstruction('')
      onChanged()
    }
  }

  return (
    <div className="kubecode-research-panel">
      {!detail.archived && (
        <form
          aria-label={t('kubecode.research.nextRound', { round: nextRound })}
          className="kubecode-research-section kubecode-research-form"
          onSubmit={(event) => {
            event.preventDefault()
            void startRound()
          }}
        >
          <h3>{t('kubecode.research.nextRound', { round: nextRound })}</h3>
          <p className="kubecode-research-muted">
            {t('kubecode.research.usesRevision', { revision: detail.revision })}
            {' '}
            {t('kubecode.research.roundRunsAgent')}
          </p>
          <div className="kubecode-research-row">
            <Select
              value={mode}
              onValueChange={(value) => {
                rekey()
                setMode(value as ResearchRoundKind)
              }}
            >
              <SelectTrigger aria-label={t('kubecode.research.roundMode')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="team">{t('kubecode.research.mode.team')}</SelectItem>
                <SelectItem value="solo">{t('kubecode.research.mode.solo')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={selectedAgent}
              onValueChange={(value) => {
                rekey()
                setAgentId(value as AgentId)
              }}
            >
              <SelectTrigger aria-label={t('kubecode.agent')} disabled={available.length === 0}>
                <SelectValue placeholder={t('kubecode.research.noAgents')} />
              </SelectTrigger>
              <SelectContent>
                {available.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agentLabel(agent.id)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            aria-label={t('kubecode.research.instruction')}
            rows={3}
            value={instruction}
            maxLength={4000}
            placeholder={t('kubecode.research.instructionPlaceholder')}
            onChange={(event) => {
              rekey()
              setInstruction(event.target.value)
            }}
          />
          {candidates.length > 0 && (
            <fieldset className="kubecode-research-carry">
              <legend>{t('kubecode.research.carryOver')}</legend>
              {candidates.map((source) => {
                const id = `${source.kind}:${source.id}`
                const usable = source.availability === 'available'
                return (
                  <label key={id}>
                    <input
                      checked={usable && !excluded.has(id)}
                      disabled={!usable}
                      type="checkbox"
                      onChange={(event) => setExcluded((current) => {
                        rekey()
                        const next = new Set(current)
                        if (event.target.checked) next.delete(id)
                        else next.add(id)
                        return next
                      })}
                    />
                    <span>{sourceKindLabel(t, source.kind)}</span>
                    <code>{source.id}</code>
                    {!usable && <AvailabilityBadge availability={source.availability} t={t} />}
                  </label>
                )
              })}
            </fieldset>
          )}
          <label className="kubecode-research-check">
            <input
              checked={allowExecution}
              type="checkbox"
              onChange={(event) => {
                rekey()
                setAllowExecution(event.target.checked)
              }}
            />
            <span>{t('kubecode.research.exec.allowExecution')}</span>
          </label>
          {allowExecution && (
            <ExecutionEnvelopeFields
              draft={envelope}
              invalid={envelopeInvalid}
              onChange={(next) => {
                rekey()
                setEnvelope(next)
              }}
              t={t}
            />
          )}
          {start.error && <p className="kubecode-research-error" role="alert">{start.error}</p>}
          <div className="kubecode-research-panel-actions">
            <Button aria-busy={start.busy} disabled={!selectedAgent || start.busy} size="sm" type="submit">
              {t('kubecode.research.startRound', { round: nextRound })}
            </Button>
          </div>
        </form>
      )}

      <section className="kubecode-research-section">
        <h3>{t('kubecode.research.rounds')}</h3>
        {rounds.length === 0 && <p className="kubecode-research-muted">{t('kubecode.research.noRounds')}</p>}
        <ul className="kubecode-research-cards">
          {rounds.map((round) => {
            const session = round.session
            const sessionId = round.kind === 'team' ? leaderConversation(round.team) ?? session?.id ?? null : session?.id ?? null
            const executionOpen = choices[round.id] ?? round.id === rounds[0]?.id
            const instructionText = typeof round.request.instruction === 'string' ? round.request.instruction : ''
            return (
              <li key={round.id}>
                <header>
                  <strong>{t('kubecode.research.roundShort', { round: round.round })}</strong>
                  <span className="kubecode-research-badge" data-tone="muted">
                    {round.kind === 'team' ? t('kubecode.research.mode.team') : t('kubecode.research.mode.solo')}
                  </span>
                  <span className="kubecode-research-muted">
                    {t('kubecode.research.contextRevision', { revision: round.brief_revision })}
                  </span>
                  {round.stale && <StaleBadge t={t} />}
                  <span className="kubecode-research-badge" data-tone={round.phase === 'started' ? 'ok' : 'warn'}>
                    {phaseLabel(t, round.phase)}
                  </span>
                </header>
                {instructionText && <p>{instructionText}</p>}
                <div className="kubecode-research-row">
                  {(round.team ?? round.session) && (
                    <span>
                      {(round.team ?? round.session)?.title || t('kubecode.untitledSession')}
                      {round.team?.state ? ` · ${round.team.state}` : ''}
                    </span>
                  )}
                  {(round.team ?? round.session) && (
                    <AvailabilityBadge availability={(round.team ?? round.session)!.availability} t={t} />
                  )}
                  {sessionId && (round.team ?? round.session)?.availability !== 'removed' && (
                    <Button size="xs" variant="outline" onClick={() => onOpenSession(sessionId)}>
                      {round.kind === 'team' ? t('kubecode.research.openTeam') : t('kubecode.research.openSession')}
                    </Button>
                  )}
                  {round.phase !== 'started' && !detail.archived && (
                    <Button
                      disabled={resume.busy}
                      size="xs"
                      variant="outline"
                      onClick={() => void resume.run(async () => {
                        await api.resumeResearchRound(detail.project_id, detail.id, round.id)
                        onChanged()
                      })}
                    >
                      {t('kubecode.research.resume')}
                    </Button>
                  )}
                </div>
                <div className="kubecode-research-row">
                  <Button
                    aria-expanded={executionOpen}
                    aria-label={`${executionOpen ? t('kubecode.research.exec.hide') : t('kubecode.research.exec.show')}: ${t('kubecode.research.roundShort', { round: round.round })}`}
                    size="xs"
                    variant="ghost"
                    onClick={() => setChoices((current) => ({ ...current, [round.id]: !executionOpen }))}
                  >
                    {executionOpen ? t('kubecode.research.exec.hide') : t('kubecode.research.exec.show')}
                  </Button>
                </div>
                {executionOpen && (
                  <ResearchExecutionSection
                    api={api}
                    archived={detail.archived}
                    connectionState={connectionState}
                    events={events}
                    projectId={detail.project_id}
                    researchId={detail.id}
                    round={round}
                    t={t}
                    teams={teams}
                  />
                )}
                {round.sources.length > 0 && (
                  <ul className="kubecode-research-sources" aria-label={t('kubecode.research.sources')}>
                    {round.sources.map((source) => (
                      <li key={`${source.kind}:${source.id}`}>
                        <span>{sourceKindLabel(t, source.kind)}</span>
                        <code>{source.id}</code>
                        <AvailabilityBadge availability={source.availability} t={t} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
        {resume.error && <p className="kubecode-research-error" role="alert">{resume.error}</p>}
      </section>
    </div>
  )
}
