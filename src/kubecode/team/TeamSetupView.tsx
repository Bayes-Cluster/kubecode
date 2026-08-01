import { useEffect, useState } from 'react'
import { UsersThree } from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
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

  const toggleAgent = (agentId: AgentId) => {
    setAllowedAgents((current) => current.includes(agentId)
      ? current.filter((candidate) => candidate !== agentId)
      : [...current, agentId])
  }

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
      <header>
        <UsersThree weight="fill" />
        <div>
          <strong>{snapshot.team.title || snapshot.leader_conversation.title}</strong>
          <span>{t('kubecode.teamSetupDescription')}</span>
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

      <div className="kubecode-team-setup-grid">
        <label className="kubecode-new-session-field">
          <span>{t('kubecode.teamGoal')}</span>
          <Textarea
            aria-label={t('kubecode.teamGoal')}
            placeholder={t('kubecode.teamGoalPlaceholder')}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label className="kubecode-new-session-field">
          <span>{t('kubecode.teamAcceptanceCriteria')}</span>
          <Textarea
            aria-label={t('kubecode.teamAcceptanceCriteria')}
            placeholder={t('kubecode.teamAcceptanceCriteriaPlaceholder')}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </label>

        <div className="kubecode-new-session-field">
          <span>{t('kubecode.teamMode')}</span>
          <div className="kubecode-choice-grid" role="group" aria-label={t('kubecode.teamMode')}>
            <Button aria-pressed={mode === 'standard'} data-active={mode === 'standard'} variant="outline" onClick={() => setMode('standard')}>
              <span>{t('kubecode.teamStandard')}</span>
              <small>{t('kubecode.teamStandardDescription')}</small>
            </Button>
            <Button aria-pressed={mode === 'yolo'} data-active={mode === 'yolo'} variant="outline" onClick={() => setMode('yolo')}>
              <span>{t('kubecode.teamYolo')}</span>
              <small>{t('kubecode.teamYoloDescription')}</small>
            </Button>
          </div>
          {mode === 'yolo' && <p className="kubecode-team-yolo-warning">{t('kubecode.teamYoloWarning')}</p>}
        </div>

        <div className="kubecode-new-session-field">
          <span>{t('kubecode.teamAllowedAgents')}</span>
          <div className="kubecode-team-agent-budget">
            {(['claude_code', 'codex', 'opencode'] as const).map((agentId) => (
              <Button
                aria-pressed={allowedAgents.includes(agentId)}
                data-active={allowedAgents.includes(agentId)}
                disabled={!availableAgents.includes(agentId)}
                key={agentId}
                size="sm"
                variant={allowedAgents.includes(agentId) ? 'default' : 'outline'}
                onClick={() => toggleAgent(agentId)}
              >
                <AiAgentIcon agent={agentId} size={16} />
                {agentName(agentId)}
              </Button>
            ))}
          </div>
        </div>

        <NativeLeaderOptions
          agentId={snapshot.leader_conversation.agent_id}
          api={api}
          conversationId={snapshot.leader_conversation.id}
          mode={mode}
          sessionState={sessionState}
          setSessionState={setSessionState}
          t={t}
        />

        <div className="kubecode-team-budget-grid">
          <NumberSelect
            label={t('kubecode.teamMemberLimit')}
            max={8}
            onChange={(value) => {
              setMaxTeammates(value)
              setMaxParallelRuns((current) => Math.min(current, value))
            }}
            value={maxTeammates}
          />
          <NumberSelect label={t('kubecode.teamConcurrency')} max={maxTeammates} onChange={setMaxParallelRuns} value={maxParallelRuns} />
          {mode === 'yolo' && (
            <NumberSelect label={t('kubecode.teamReviewRounds')} max={10} onChange={setMaxReviewRounds} value={maxReviewRounds} />
          )}
        </div>
      </div>

      <footer>
        {onCancel && <Button variant="ghost" onClick={onCancel}>{t('kubecode.cancel')}</Button>}
        <Button
          aria-busy={starting}
          disabled={starting || !goal.trim() || !criteria.trim() || allowedAgents.length === 0}
          onClick={() => void start()}
        >
          {starting ? t('kubecode.loading') : t('kubecode.teamStart')}
        </Button>
      </footer>
    </section>
  )
}

function NumberSelect({ label, max, onChange, value }: {
  label: string
  max: number
  onChange: (value: number) => void
  value: number
}) {
  return (
    <label>
      <span>{label}</span>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {Array.from({ length: max }, (_, index) => index + 1).map((option) => (
            <SelectItem key={option} value={String(option)}>{option}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}
