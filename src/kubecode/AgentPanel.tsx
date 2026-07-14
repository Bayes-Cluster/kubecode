import { useEffect, useMemo, useRef, useState } from 'react'

import {
  AiPanelComposer,
  AiPanelHeader,
  AiPanelMessageHistory,
} from '@/components/AiPanelChrome'
import type { AiAction } from '@/components/AiMessage'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { AiAgentPermissionMode } from '@/lib/aiAgentPermissionMode'
import type { AppLocale, TranslationKey } from '@/lib/i18n'
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
  locale: AppLocale
  onClose: () => void
  onConversationCreated: (conversation: Conversation) => void
  projectId: string
  t: Translator
  width: number
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
  locale,
  onClose,
  onConversationCreated,
  projectId,
  t,
  width,
}: AgentPanelProps) {
  const availableAgent = agents.find((agent) => agent.available) ?? agents[0]
  const [agentId, setAgentId] = useState<AgentId>(availableAgent?.id ?? 'codex')
  const [permissionMode, setPermissionMode] = useState<AiAgentPermissionMode>('safe')
  const [prompt, setPrompt] = useState('')
  const [run, setRun] = useState<AgentRun | null>(null)
  const [messages, setMessages] = useState<AiAgentMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const runId = run?.id
  const isActive = run?.status === 'running' || run?.status === 'waiting_permission'
  const selectedAgent = agents.find((agent) => agent.id === agentId)
  const activeAgentId = selectedAgent?.available || !availableAgent?.available
    ? agentId
    : availableAgent.id
  const activeAgent = agents.find((agent) => agent.id === activeAgentId)
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.agent_id === activeAgentId),
    [activeAgentId, conversations],
  )

  useEffect(() => {
    if (!runId) return
    const stream = new EventSource(api.eventStreamUrl(runId))
    const receive = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as AgentEvent
      setMessages((current) => applyAgentEvent(current, runId, event))
      if (event.kind === 'run_completed') {
        void api.getRun(runId).then(setRun)
        stream.close()
      }
    }
    for (const name of EVENT_NAMES) stream.addEventListener(name, receive as EventListener)
    stream.onerror = () => setError(t('kubecode.error'))
    return () => stream.close()
  }, [api, runId, t])

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || !activeAgent?.available || isActive) return
    setError(null)
    try {
      const conversation = selectedConversation ?? await api.createConversation(
        projectId,
        activeAgentId,
        message.slice(0, 60),
      )
      if (!selectedConversation) onConversationCreated(conversation)
      const nextRun = await api.startRun(
        projectId,
        conversation.id,
        message,
        permissionMode === 'power_user' ? 'power' : 'safe',
      )
      setMessages((current) => [
        ...current,
        {
          actions: [],
          id: nextRun.id,
          isStreaming: true,
          reasoningDone: false,
          userMessage: message,
        },
      ])
      setRun(nextRun)
      setPrompt('')
      trackEvent('kubecode_agent_run_started', {
        agent_id: activeAgentId,
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

  const newChat = () => {
    if (isActive) return
    setMessages([])
    setRun(null)
    setError(null)
  }

  const readiness = activeAgent?.available ? 'ready' : 'missing'
  const agentLabel = agentName(activeAgentId)

  return (
    <aside
      className="kubecode-agent-panel flex flex-col overflow-hidden bg-sidebar text-sidebar-foreground"
      data-testid="ai-panel"
      style={{ width }}
    >
      <AiPanelHeader
        agentLabel={agentLabel}
        agentReadiness={readiness}
        locale={locale}
        permissionMode={permissionMode}
        permissionModeControlLabels={{
          power_user: t('kubecode.power'),
          safe: t('kubecode.safe'),
        }}
        permissionModeDisabled={Boolean(isActive)}
        onPermissionModeChange={setPermissionMode}
        onClose={onClose}
        onNewChat={newChat}
      />
      <AiPanelMessageHistory
        agentLabel={agentLabel}
        agentReadiness={readiness}
        locale={locale}
        messages={messages}
        isActive={Boolean(isActive)}
        hasContext
      />
      {error && <div className="kubecode-inline-error">{error}</div>}
      <AiPanelComposer
        entries={[]}
        agentLabel={agentLabel}
        agentReadiness={readiness}
        locale={locale}
        input={prompt}
        inputRef={inputRef}
        isActive={Boolean(isActive)}
        controls={(
          <Select value={activeAgentId} onValueChange={(value) => setAgentId(value as AgentId)}>
            <SelectTrigger
              aria-label={t('kubecode.agent')}
              className="h-7 max-w-40 border-0 bg-transparent px-2 text-xs shadow-none"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem disabled={!agent.available} key={agent.id} value={agent.id}>
                  {agentName(agent.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        onChange={setPrompt}
        onSend={(text) => void send(text)}
        onStop={() => void stop()}
      />
    </aside>
  )
}

function applyAgentEvent(
  messages: AiAgentMessage[],
  runId: string,
  event: AgentEvent,
): AiAgentMessage[] {
  return messages.map((message) => {
    if (message.id !== runId) return message
    if (event.kind === 'text_delta') {
      return { ...message, response: `${message.response ?? ''}${textValue(event.payload.text)}` }
    }
    if (event.kind === 'thinking_delta') {
      return { ...message, reasoning: `${message.reasoning ?? ''}${textValue(event.payload.text)}` }
    }
    if (event.kind === 'tool_started') {
      return { ...message, actions: upsertAction(message.actions, event, 'pending') }
    }
    if (event.kind === 'tool_updated') {
      return { ...message, actions: upsertAction(message.actions, event, 'pending') }
    }
    if (event.kind === 'tool_completed') {
      return { ...message, actions: upsertAction(message.actions, event, 'done') }
    }
    if (event.kind === 'error') {
      return {
        ...message,
        isStreaming: false,
        reasoningDone: true,
        response: `${message.response ?? ''}${textValue(event.payload.message)}`,
      }
    }
    if (event.kind === 'run_completed') {
      return { ...message, isStreaming: false, reasoningDone: true }
    }
    return message
  })
}

function upsertAction(
  actions: AiAction[],
  event: AgentEvent,
  status: AiAction['status'],
): AiAction[] {
  const toolId = textValue(event.payload.tool_id) || `tool-${event.seq}`
  const tool = textValue(event.payload.tool) || 'Tool'
  const existing = actions.find((action) => action.toolId === toolId)
  const action: AiAction = {
    input: displayValue(event.payload.input) || existing?.input,
    label: tool,
    output: displayValue(event.payload.output) || existing?.output,
    status,
    tool,
    toolId,
  }
  return existing
    ? actions.map((current) => current.toolId === toolId ? action : current)
    : [...actions, action]
}

function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function agentName(id: AgentId): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}
