import { useEffect, useState } from 'react'
import { TriangleAlert, Users } from 'lucide-react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { trackEvent } from '@/lib/telemetry'

import type { AgentId, AgentSessionState, KubecodeApi, TeamMode, TeamSnapshot } from '../api'
import { SystemMessageNotice } from '../SystemMessageNotice'
import { NativeLeaderOptions } from './TeamPermissionView'
import type { Translator } from '@/lib/i18n'

export function TeamSetup({
  api,
  onCancel,
  onSnapshotChange,
  snapshot,
  t,
}: {
  api: KubecodeApi
  onCancel?: () => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const [goal, setGoal] = useState(snapshot.team.goal)
  const [criteria, setCriteria] = useState(snapshot.team.acceptance_criteria.join('\n'))
  const [mode, setMode] = useState<TeamMode>(snapshot.team.requested_mode)
  const [allowedAgents, setAllowedAgents] = useState<AgentId[]>(snapshot.team.allowed_agent_ids)
  const [availableAgents, setAvailableAgents] = useState<AgentId[]>([])
  const [maxTeammates, setMaxTeammates] = useState(snapshot.team.max_teammates || 3)
  const [maxParallelRuns, setMaxParallelRuns] = useState(snapshot.team.max_parallel_runs || 2)
  const [maxReviewRounds, setMaxReviewRounds] = useState(snapshot.team.max_review_rounds || 3)
  const [sessionState, setSessionState] = useState<AgentSessionState | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([
      api.listAgents(),
      api.getSessionState(snapshot.leader_conversation.id),
    ]).then(([agents, state]) => {
      if (!active) return
      const available = agents.filter((agent) => agent.available).map((agent) => agent.id)
      setAvailableAgents(available)
      setAllowedAgents((current) => {
        const installed = current.filter((agentId) => available.includes(agentId))
        return installed.length > 0 ? installed : available
      })
      setSessionState(state)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    })
    return () => { active = false }
  }, [api, snapshot.leader_conversation.id, t])

  const start = async () => {
    const acceptanceCriteria = criteria.split('\n').map((value) => value.trim()).filter(Boolean)
    if (!goal.trim() || acceptanceCriteria.length === 0 || allowedAgents.length === 0) return
    setStarting(true)
    setError(null)
    try {
      const concurrency = Math.min(maxParallelRuns, maxTeammates)
      const updated = await api.startTeam(snapshot.team.id, {
        goal: goal.trim(),
        acceptance_criteria: acceptanceCriteria,
        allowed_agent_ids: allowedAgents,
        mode,
        max_teammates: maxTeammates,
        max_parallel_runs: concurrency,
        max_review_rounds: maxReviewRounds,
      })
      trackEvent('kubecode_team_started', {
        leader_agent_id: snapshot.leader_conversation.agent_id,
        mode,
        max_teammates: maxTeammates,
        max_parallel_runs: concurrency,
      })
      if (mode === 'yolo' && updated.team.mode === 'yolo') {
        trackEvent('kubecode_team_native_permission_applied', {
          agent_id: snapshot.leader_conversation.agent_id,
        })
      }
      if (mode === 'yolo' && updated.team.mode_fallback) {
        trackEvent('kubecode_team_mode_fallback', {
          agent_id: updated.team.mode_fallback.agent_id,
          reason_code: updated.team.mode_fallback.reason_code,
        })
      }
      onSnapshotChange(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="kubecode-team-workspace kubecode-team-setup" data-testid="team-setup">
      <header className="flex items-start gap-2">
        <Users aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-sm font-medium">{snapshot.team.title || snapshot.leader_conversation.title}</h2>
          <p className="text-sm text-muted-foreground">{t('kubecode.teamSetupDescription')}</p>
        </div>
      </header>

      {error && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      <FieldGroup className="kubecode-team-setup-grid">
        <Field>
          <FieldLabel htmlFor="team-setup-goal">{t('kubecode.teamGoal')}</FieldLabel>
          <Textarea
            id="team-setup-goal"
            placeholder={t('kubecode.teamGoalPlaceholder')}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="team-setup-criteria">{t('kubecode.teamAcceptanceCriteria')}</FieldLabel>
          <Textarea
            id="team-setup-criteria"
            placeholder={t('kubecode.teamAcceptanceCriteriaPlaceholder')}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </Field>

        <FieldSet>
          <FieldLegend variant="label">{t('kubecode.teamMode')}</FieldLegend>
          <RadioGroup
            aria-label={t('kubecode.teamMode')}
            className="grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]"
            value={mode}
            onValueChange={(value) => {
              if (value === 'standard' || value === 'yolo') setMode(value)
            }}
          >
            {(['standard', 'yolo'] as const).map((value) => (
              <FieldLabel htmlFor={`team-setup-mode-${value}`} key={value}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{t(value === 'standard' ? 'kubecode.teamStandard' : 'kubecode.teamYolo')}</FieldTitle>
                    <FieldDescription>
                      {t(value === 'standard' ? 'kubecode.teamStandardDescription' : 'kubecode.teamYoloDescription')}
                    </FieldDescription>
                  </FieldContent>
                  <RadioGroupItem id={`team-setup-mode-${value}`} value={value} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
          {mode === 'yolo' && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{t('kubecode.teamYoloWarning')}</AlertDescription>
            </Alert>
          )}
        </FieldSet>

        <FieldSet>
          <FieldLegend variant="label">{t('kubecode.teamAllowedAgents')}</FieldLegend>
          <ToggleGroup
            aria-label={t('kubecode.teamAllowedAgents')}
            className="flex-wrap"
            type="multiple"
            value={allowedAgents}
            variant="outline"
            onValueChange={(value) => setAllowedAgents(value as AgentId[])}
          >
            {(['claude_code', 'codex', 'opencode'] as const).map((agentId) => (
              <ToggleGroupItem
                disabled={!availableAgents.includes(agentId)}
                key={agentId}
                value={agentId}
              >
                <AiAgentIcon agent={agentId} size={16} />
                {agentName(agentId)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FieldSet>

        <NativeLeaderOptions
          agentId={snapshot.leader_conversation.agent_id}
          api={api}
          conversationId={snapshot.leader_conversation.id}
          mode={mode}
          sessionState={sessionState}
          setSessionState={setSessionState}
          t={t}
        />

        <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
          <NumberSelect
            id="team-setup-members"
            label={t('kubecode.teamMemberLimit')}
            max={8}
            onChange={(value) => {
              setMaxTeammates(value)
              setMaxParallelRuns((current) => Math.min(current, value))
            }}
            value={maxTeammates}
          />
          <NumberSelect
            id="team-setup-concurrency"
            label={t('kubecode.teamConcurrency')}
            max={maxTeammates}
            onChange={setMaxParallelRuns}
            value={maxParallelRuns}
          />
          {mode === 'yolo' && (
            <NumberSelect
              id="team-setup-review-rounds"
              label={t('kubecode.teamReviewRounds')}
              max={10}
              onChange={setMaxReviewRounds}
              value={maxReviewRounds}
            />
          )}
        </div>
      </FieldGroup>

      <footer className="flex flex-wrap justify-end gap-2">
        {onCancel && <Button variant="ghost" onClick={onCancel}>{t('kubecode.cancel')}</Button>}
        <Button
          aria-busy={starting}
          disabled={starting || !goal.trim() || !criteria.trim() || allowedAgents.length === 0}
          onClick={() => void start()}
        >
          {starting && <Spinner data-icon="inline-start" />}
          {starting ? t('kubecode.loading') : t('kubecode.teamStart')}
        </Button>
      </footer>
    </section>
  )
}

function NumberSelect({ id, label, max, onChange, value }: {
  id: string
  label: string
  max: number
  onChange: (value: number) => void
  value: number
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger aria-label={label} id={id}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {Array.from({ length: max }, (_, index) => index + 1).map((option) => (
              <SelectItem key={option} value={String(option)}>{option}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}
