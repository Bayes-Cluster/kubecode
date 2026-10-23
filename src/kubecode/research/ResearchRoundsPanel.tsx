import { useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Info } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Item, ItemGroup, ItemTitle } from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type {
  AgentDescriptor,
  AgentId,
  ExecutionEnvelopeLimits,
  KubecodeApi,
  ResearchDetail,
  ResearchFinding,
  ResearchImport,
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
import { ResearchPanel, ResearchSection } from './ResearchLayout'
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
  imports = [],
  onChanged,
  onOpenSession,
  rounds,
  startsRounds = true,
  t,
  teams,
}: {
  agents: AgentDescriptor[]
  api: KubecodeApi
  connectionState: WorkspaceConnectionState
  detail: ResearchDetail
  events: WorkspaceEvent[]
  findings: ResearchFinding[]
  /** Imported discussions that can be cited by this round. */
  imports?: ResearchImport[]
  onChanged: () => void
  onOpenSession: (conversationId: string) => void
  rounds: ResearchRound[]
  /**
   * Whether this surface can start a round. A Task's detail cannot: work starts
   * when the researcher tells the General Agent to, so nothing here bypasses it.
   */
  startsRounds?: boolean
  t: Translator
  teams: TeamSnapshot[]
}) {
  const available = agents.filter((agent) => agent.available)
  const candidates = useMemo(() => carryOverCandidates(findings), [findings])
  const [mode, setMode] = useState<ResearchRoundKind>('team')
  const [agentId, setAgentId] = useState<AgentId | ''>('')
  const [instruction, setInstruction] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  // Imported discussions are cited only when the researcher picks them.
  const [citedImports, setCitedImports] = useState<Set<string>>(new Set())
  // One key per intended round: retrying after a lost response resumes the
  // same round instead of creating a second one.
  const requestKey = useRef(newClientMessageId())
  const start = useAction(t)
  const resume = useAction(t)
  const fieldId = useId()
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
      sources: [
        ...carried.map((source) => ({ kind: source.kind, id: source.id })),
        ...imports
          .filter((item) => citedImports.has(item.id))
          .map((item) => ({ kind: 'import' as const, id: item.id })),
      ],
      ...(limits ? { envelope: limits } : {}),
    }))
    if (started) {
      requestKey.current = newClientMessageId()
      setInstruction('')
      setCitedImports(new Set())
      onChanged()
    }
  }

  return (
    <ResearchPanel>
      {!detail.archived && !startsRounds && (
        <Alert role="status"><Info /><AlertDescription>{t('kubecode.task.startsInGeneral')}</AlertDescription></Alert>
      )}
      {!detail.archived && startsRounds && (
        <form
          aria-label={t('kubecode.research.nextRound', { round: nextRound })}
          onSubmit={(event) => {
            event.preventDefault()
            void startRound()
          }}
        >
          <ResearchSection label={t('kubecode.research.nextRound', { round: nextRound })}>
            <FieldGroup className="gap-3">
              <FieldDescription>
                {t('kubecode.research.usesRevision', { revision: detail.revision })}
                {' '}
                {t('kubecode.research.roundRunsAgent')}
              </FieldDescription>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={mode}
                  onValueChange={(value) => {
                    rekey()
                    setMode(value as ResearchRoundKind)
                  }}
                >
                  <SelectTrigger aria-label={t('kubecode.research.roundMode')} className="min-w-[140px] flex-1 sm:flex-none"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="team">{t('kubecode.research.mode.team')}</SelectItem>
                      <SelectItem value="solo">{t('kubecode.research.mode.solo')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Select
                  value={selectedAgent}
                  onValueChange={(value) => {
                    rekey()
                    setAgentId(value as AgentId)
                  }}
                >
                  <SelectTrigger aria-label={t('kubecode.agent')} className="min-w-[140px] flex-1 sm:flex-none" disabled={available.length === 0}>
                    <SelectValue placeholder={t('kubecode.research.noAgents')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {available.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>{agentLabel(agent.id)}</SelectItem>
                      ))}
                    </SelectGroup>
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
                <FieldSet className="rounded-md border p-3">
                  <FieldLegend variant="label">{t('kubecode.research.carryOver')}</FieldLegend>
                  <FieldGroup className="gap-2">
                    {candidates.map((source) => {
                      const id = `${source.kind}:${source.id}`
                      const usable = source.availability === 'available'
                      const controlId = `${fieldId}-carry-${id}`
                      return (
                        <Field data-disabled={!usable || undefined} key={id} orientation="horizontal">
                          <Checkbox
                            checked={usable && !excluded.has(id)}
                            disabled={!usable}
                            id={controlId}
                            onCheckedChange={(checked) => setExcluded((current) => {
                              rekey()
                              const next = new Set(current)
                              if (checked === true) next.delete(id)
                              else next.add(id)
                              return next
                            })}
                          />
                          <FieldLabel className="flex-wrap font-normal" htmlFor={controlId}>
                            <span>{sourceKindLabel(t, source.kind)}</span>
                            <code className="[overflow-wrap:anywhere]">{source.id}</code>
                          </FieldLabel>
                          {!usable && <AvailabilityBadge availability={source.availability} t={t} />}
                        </Field>
                      )
                    })}
                  </FieldGroup>
                </FieldSet>
              )}
              {imports.length > 0 && (
                <FieldSet className="rounded-md border p-3">
                  <FieldLegend variant="label">{t('kubecode.research.import.handoff')}</FieldLegend>
                  <FieldGroup className="gap-2">
                    {imports.map((item) => {
                      const controlId = `${fieldId}-import-${item.id}`
                      return (
                        <Field key={item.id} orientation="horizontal">
                          <Checkbox
                            checked={citedImports.has(item.id)}
                            id={controlId}
                            onCheckedChange={(checked) => setCitedImports((current) => {
                              rekey()
                              const next = new Set(current)
                              if (checked === true) next.add(item.id)
                              else next.delete(item.id)
                              return next
                            })}
                          />
                          <FieldContent>
                            <FieldLabel className="font-normal" htmlFor={controlId}>{item.label}</FieldLabel>
                            {item.stale && (
                              <FieldDescription>
                                {t('kubecode.research.import.stale', {
                                  based: item.based_on_revision,
                                  current: item.current_revision,
                                })}
                              </FieldDescription>
                            )}
                          </FieldContent>
                        </Field>
                      )
                    })}
                  </FieldGroup>
                  <FieldDescription>
                    {t('kubecode.research.import.handoffSummary', {
                      revision: detail.revision,
                      count: citedImports.size,
                    })}
                  </FieldDescription>
                </FieldSet>
              )}
              <Field orientation="horizontal">
                <Checkbox
                  checked={allowExecution}
                  id={`${fieldId}-allow-execution`}
                  onCheckedChange={(checked) => {
                    rekey()
                    setAllowExecution(checked === true)
                  }}
                />
                <FieldLabel className="font-normal" htmlFor={`${fieldId}-allow-execution`}>{t('kubecode.research.exec.allowExecution')}</FieldLabel>
              </Field>
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
              {start.error && <Alert variant="destructive"><AlertDescription>{start.error}</AlertDescription></Alert>}
              <div className="flex justify-end">
                <Button aria-busy={start.busy} disabled={!selectedAgent || start.busy} size="sm" type="submit">
                  {t('kubecode.research.startRound', { round: nextRound })}
                </Button>
              </div>
            </FieldGroup>
          </ResearchSection>
        </form>
      )}

      <ResearchSection label={t('kubecode.research.rounds')}>
        {rounds.length === 0 && (
          <Empty className="items-start p-0 text-left md:p-0">
            <EmptyDescription>{t('kubecode.research.noRounds')}</EmptyDescription>
          </Empty>
        )}
        <ItemGroup className="gap-2 empty:hidden">
          {rounds.map((round) => {
            const session = round.session
            const sessionId = round.kind === 'team' ? leaderConversation(round.team) ?? session?.id ?? null : session?.id ?? null
            const executionOpen = choices[round.id] ?? round.id === rounds[0]?.id
            const instructionText = typeof round.request.instruction === 'string' ? round.request.instruction : ''
            const target = round.team ?? round.session
            return (
              <Item key={round.id} role="listitem" size="sm" variant="outline">
                <Collapsible
                  className="flex w-full min-w-0 flex-col gap-2"
                  open={executionOpen}
                  onOpenChange={(open) => setChoices((current) => ({ ...current, [round.id]: open }))}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ItemTitle>{t('kubecode.research.roundShort', { round: round.round })}</ItemTitle>
                    <StatusBadge tone="muted">
                      {round.kind === 'team' ? t('kubecode.research.mode.team') : t('kubecode.research.mode.solo')}
                    </StatusBadge>
                    <span className="text-xs text-muted-foreground">
                      {t('kubecode.research.contextRevision', { revision: round.brief_revision })}
                    </span>
                    {round.stale && <StaleBadge t={t} />}
                    <StatusBadge tone={round.phase === 'started' ? 'ok' : 'warn'}>
                      {phaseLabel(t, round.phase)}
                    </StatusBadge>
                  </div>
                  {instructionText && <p className="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{instructionText}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    {target && (
                      <span className="text-sm [overflow-wrap:anywhere]">
                        {target.title || t('kubecode.untitledSession')}
                        {round.team?.state ? ` · ${round.team.state}` : ''}
                      </span>
                    )}
                    {target && <AvailabilityBadge availability={target.availability} t={t} />}
                    {sessionId && target?.availability !== 'removed' && (
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
                    <CollapsibleTrigger asChild>
                      <Button
                        aria-label={`${executionOpen ? t('kubecode.research.exec.hide') : t('kubecode.research.exec.show')}: ${t('kubecode.research.roundShort', { round: round.round })}`}
                        className="[&[data-state=closed]>svg]:-rotate-90"
                        size="xs"
                        variant="ghost"
                      >
                        <ChevronDown data-icon="inline-start" />
                        {executionOpen ? t('kubecode.research.exec.hide') : t('kubecode.research.exec.show')}
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent>
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
                  </CollapsibleContent>
                  {round.sources.length > 0 && (
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-muted-foreground" aria-label={t('kubecode.research.sources')}>
                      {round.sources.map((source) => (
                        <li className="flex flex-wrap items-center gap-1.5" key={`${source.kind}:${source.id}`}>
                          <span>{sourceKindLabel(t, source.kind)}</span>
                          <code className="[overflow-wrap:anywhere]">{source.id}</code>
                          <AvailabilityBadge availability={source.availability} t={t} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Collapsible>
              </Item>
            )
          })}
        </ItemGroup>
        {resume.error && <Alert variant="destructive"><AlertDescription>{resume.error}</AlertDescription></Alert>}
      </ResearchSection>
    </ResearchPanel>
  )
}
