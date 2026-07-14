import { useEffect, useMemo, useRef, useState } from 'react'
import { PaperPlaneTilt, Stop } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { TranslationKey } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type {
  AgentDescriptor,
  AgentEvent,
  AgentId,
  AgentRun,
  Conversation,
  KubecodeApi,
} from './api'

type Translator = (key: TranslationKey) => string

type AgentPanelProps = {
  api: KubecodeApi
  agents: AgentDescriptor[]
  conversations: Conversation[]
  onConversationCreated: (conversation: Conversation) => void
  projectId: string
  t: Translator
}

const EVENT_NAMES = [
  'run_started', 'text_delta', 'thinking_delta', 'tool_started', 'tool_updated',
  'tool_completed', 'permission_requested', 'permission_resolved', 'usage', 'error',
  'run_completed',
]

export function AgentPanel({
  api,
  agents,
  conversations,
  onConversationCreated,
  projectId,
  t,
}: AgentPanelProps) {
  const availableAgent = agents.find((agent) => agent.available) ?? agents[0]
  const [agentId, setAgentId] = useState<AgentId>(availableAgent?.id ?? 'codex')
  const [permissionMode, setPermissionMode] = useState<'safe' | 'power'>('safe')
  const [prompt, setPrompt] = useState('')
  const [run, setRun] = useState<AgentRun | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const output = useRef<HTMLDivElement>(null)
  const runId = run?.id

  const selectedAgent = agents.find((agent) => agent.id === agentId)
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.agent_id === agentId),
    [agentId, conversations],
  )

  useEffect(() => {
    if (!runId) return
    const stream = new EventSource(api.eventStreamUrl(runId))
    const receive = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as AgentEvent
      setEvents((current) => current.some((item) => item.seq === event.seq)
        ? current
        : [...current, event])
      if (event.kind === 'run_completed') {
        void api.getRun(runId).then(setRun)
        stream.close()
      }
    }
    for (const name of EVENT_NAMES) stream.addEventListener(name, receive as EventListener)
    stream.onerror = () => setError(t('kubecode.error'))
    return () => stream.close()
  }, [api, runId, t])

  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight
  }, [events])

  const send = async () => {
    const message = prompt.trim()
    if (!message || !selectedAgent?.available || run?.status === 'running') return
    setError(null)
    try {
      const conversation = selectedConversation ?? await api.createConversation(
        projectId,
        agentId,
        message.slice(0, 60),
      )
      if (!selectedConversation) onConversationCreated(conversation)
      const nextRun = await api.startRun(
        projectId,
        conversation.id,
        message,
        permissionMode,
      )
      setEvents([])
      setRun(nextRun)
      setPrompt('')
      trackEvent('kubecode_agent_run_started', {
        agent_id: agentId,
        permission_mode: permissionMode,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    }
  }

  const stop = async () => {
    if (!run) return
    await api.cancelRun(run.id)
  }

  return (
    <aside className="kubecode-agent-panel">
      <div className="kubecode-panel-header">
        <strong>{t('kubecode.agent')}</strong>
        <Select value={agentId} onValueChange={(value) => setAgentId(value as AgentId)}>
          <SelectTrigger size="sm" aria-label={t('kubecode.agent')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agentName(agent.id)}{agent.available ? '' : ' · unavailable'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="kubecode-agent-output" ref={output}>
        {events.length === 0 && (
          <div className="kubecode-empty">{t('kubecode.noAgentOutput')}</div>
        )}
        {events.map((event) => <AgentEventRow event={event} key={event.seq} />)}
      </div>
      {!selectedAgent?.available && (
        <div className="kubecode-inline-error">{t('kubecode.agentUnavailable')}</div>
      )}
      {error && <div className="kubecode-inline-error">{error}</div>}
      <div className="kubecode-agent-compose">
        <div className="kubecode-mode-switch">
          <Button
            size="xs"
            variant={permissionMode === 'safe' ? 'default' : 'ghost'}
            onClick={() => setPermissionMode('safe')}
          >
            {t('kubecode.safe')}
          </Button>
          <Button
            size="xs"
            variant={permissionMode === 'power' ? 'default' : 'ghost'}
            onClick={() => setPermissionMode('power')}
          >
            {t('kubecode.power')}
          </Button>
        </div>
        <Textarea
          aria-label={t('kubecode.agentPlaceholder')}
          placeholder={t('kubecode.agentPlaceholder')}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {run?.status === 'running' ? (
          <Button variant="outline" onClick={() => void stop()}>
            <Stop weight="fill" /> {t('kubecode.stop')}
          </Button>
        ) : (
          <Button disabled={!prompt.trim() || !selectedAgent?.available} onClick={() => void send()}>
            <PaperPlaneTilt /> {t('kubecode.send')}
          </Button>
        )}
      </div>
    </aside>
  )
}

function AgentEventRow({ event }: { event: AgentEvent }) {
  if (event.kind === 'run_started' || event.kind === 'run_completed') {
    return <div className="kubecode-agent-status">{event.kind.replace('_', ' ')}</div>
  }
  if (event.kind === 'text_delta') {
    return <div className="kubecode-agent-text">{String(event.payload.text ?? '')}</div>
  }
  if (event.kind === 'thinking_delta') {
    return <div className="kubecode-agent-thinking">{String(event.payload.text ?? '')}</div>
  }
  if (event.kind.startsWith('tool_')) {
    return (
      <div className="kubecode-agent-tool">
        <strong>{String(event.payload.tool ?? event.kind)}</strong>
        <pre>{JSON.stringify(event.payload.input ?? event.payload.output ?? {}, null, 2)}</pre>
      </div>
    )
  }
  if (event.kind === 'error') {
    return <div className="kubecode-inline-error">{String(event.payload.message ?? 'Agent error')}</div>
  }
  return null
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}
