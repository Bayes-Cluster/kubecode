import { useEffect, useRef, useState } from 'react'
import { DotsThree } from '@phosphor-icons/react'

import { AiAgentIcon } from '@/components/AiAgentIcon'
import { AiPanelComposer, AiPanelMessageHistory } from '@/components/AiPanelChrome'
import type { AiAction } from '@/components/AiMessage'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AiAgentMessage } from '@/lib/aiAgentConversation'
import type { AiAgentPermissionMode } from '@/lib/aiAgentPermissionMode'
import type { AppLocale, TranslationKey } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import type {
  AgentDescriptor,
  AgentEvent,
  AgentRun,
  Conversation,
  KubecodeApi,
  WorkspaceEvent,
} from './api'

type Translator = (key: TranslationKey) => string
type PermissionChoice = { id: string; label: string; kind: string }
type PendingPermission = { requestId: string; tool: string; options: PermissionChoice[] }

type AgentSessionWorkspaceProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  conversation: Conversation | null
  locale: AppLocale
  projectId: string | null
  t: Translator
  workspaceEvent: WorkspaceEvent | null
}

const ACTIVE_RUN_STATUSES = new Set<AgentRun['status']>(['running', 'waiting_permission'])
export function AgentSessionWorkspace({
  agents,
  api,
  conversation,
  locale,
  projectId,
  t,
  workspaceEvent,
}: AgentSessionWorkspaceProps) {
  const [permissionMode, setPermissionMode] = useState<AiAgentPermissionMode>('safe')
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<AiAgentMessage[]>([])
  const [run, setRun] = useState<AgentRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const agent = agents.find((item) => item.id === conversation?.agent_id)
  const agentLabel = conversation ? agentName(conversation.agent_id) : t('kubecode.agent')
  const active = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))

  useEffect(() => {
    if (!conversation) return
    let current = true
    void hydrateConversation(api, conversation.id).then(({ messages: history, activeRun, pendingPermission: restoredPermission }) => {
      if (!current) return
      setMessages(history)
      setRun(activeRun)
      setPendingPermission(restoredPermission)
    }).catch((cause: unknown) => {
      if (current) setError(errorMessage(cause, t('kubecode.error')))
    })
    return () => { current = false }
  }, [api, conversation, t])

  useEffect(() => {
    if (!conversation || workspaceEvent?.conversation_id !== conversation.id || !workspaceEvent.run_id) return
    const event: AgentEvent = {
      created_at: workspaceEvent.created_at,
      kind: workspaceEvent.kind,
      payload: workspaceEvent.payload,
      run_id: workspaceEvent.run_id,
      seq: workspaceEvent.id,
    }
    if (event.kind === 'permission_requested') {
      const permission = permissionFromEvent(event)
      if (permission) queueMicrotask(() => setPendingPermission(permission))
    }
    if (event.kind === 'permission_resolved') {
      queueMicrotask(() => setPendingPermission(null))
    }
    if (event.kind === 'run_started') {
      void api.getRun(event.run_id).then((nextRun) => {
        setMessages((current) => current.some((message) => message.id === nextRun.id)
          ? current
          : [...current, messageFromRun(nextRun)])
        setRun(nextRun)
      })
      return
    }
    queueMicrotask(() => {
      setMessages((current) => applyAgentEvent(current, event.run_id, event))
    })
    if (event.kind === 'run_completed') void api.getRun(event.run_id).then(setRun)
  }, [api, conversation, workspaceEvent])

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || !conversation || !projectId || !agent?.available || active) return
    setError(null)
    try {
      const nextRun = await api.startRun(
        projectId,
        conversation.id,
        message,
        permissionMode === 'power_user' ? 'power' : 'safe',
      )
      setMessages((current) => [...current, messageFromRun(nextRun)])
      setRun(nextRun)
      setPrompt('')
      trackEvent('kubecode_agent_run_started', {
        agent_id: conversation.agent_id,
        permission_mode: permissionMode,
      })
    } catch (cause) {
      setError(errorMessage(cause, t('kubecode.error')))
    }
  }

  const stop = async () => {
    if (run) await api.cancelRun(run.id)
  }

  if (!conversation) {
    return (
      <section className="kubecode-agent-session kubecode-session-empty" data-testid="agent-session-workspace">
        <div className="kubecode-session-empty-mark">K</div>
        <h1>{t('kubecode.startSession')}</h1>
        <p>{projectId ? t('kubecode.startSessionDescription') : t('kubecode.selectProject')}</p>
        {projectId && <span className="kubecode-session-empty-hint">{t('kubecode.newSessionDescription')}</span>}
      </section>
    )
  }

  const readiness = agent?.available ? 'ready' : 'missing'
  return (
    <section className="kubecode-agent-session" data-testid="agent-session-workspace">
      <header className="kubecode-session-header">
        <div className="kubecode-session-title">
          <AiAgentIcon agent={conversation.agent_id} size={17} />
          <strong>{conversation.title}</strong>
        </div>
        <div className="kubecode-session-status">
          <span data-state={active ? 'running' : 'idle'} />
          {active ? t('kubecode.running') : t('kubecode.ready')}
          <Button aria-label={t('kubecode.sessionActions')} size="icon-xs" variant="ghost">
            <DotsThree />
          </Button>
        </div>
      </header>
      <div className="kubecode-session-timeline">
        <AiPanelMessageHistory
          agentLabel={agentLabel}
          agentReadiness={readiness}
          hasContext
          isActive={active}
          locale={locale}
          messages={messages}
        />
      </div>
      {error && <div className="kubecode-inline-error">{error}</div>}
      {pendingPermission && (
        <div className="kubecode-permission-dock">
          <div>
            <strong>{t('kubecode.permissionRequired')}</strong>
            <span>{pendingPermission.tool}</span>
          </div>
          <div>
            {pendingPermission.options.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant={option.kind.startsWith('reject') ? 'outline' : 'default'}
                onClick={() => void api.resolvePermission(pendingPermission.requestId, option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="kubecode-session-composer">
        <AiPanelComposer
          agentLabel={agentLabel}
          agentReadiness={readiness}
          controls={(
            <div className="kubecode-composer-controls">
              <span className="kubecode-agent-chip">
                <AiAgentIcon agent={conversation.agent_id} size={14} /> {agentLabel}
              </span>
              <Select
                disabled={active}
                value={permissionMode}
                onValueChange={(value) => setPermissionMode(value as AiAgentPermissionMode)}
              >
                <SelectTrigger aria-label={t('kubecode.permissionMode')} className="h-7 w-auto border-0 bg-transparent px-2 text-xs shadow-none" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="safe">{t('kubecode.safe')}</SelectItem>
                  <SelectItem value="power_user">{t('kubecode.power')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          entries={[]}
          input={prompt}
          inputRef={inputRef}
          isActive={active}
          locale={locale}
          onChange={setPrompt}
          onSend={(text) => void send(text)}
          onStop={() => void stop()}
        />
      </div>
    </section>
  )
}

async function hydrateConversation(
  api: KubecodeApi,
  conversationId: string,
): Promise<{
  messages: AiAgentMessage[]
  activeRun: AgentRun | null
  pendingPermission: PendingPermission | null
}> {
  const runs = await api.listRuns(conversationId)
  const events = await Promise.all(runs.map((run) => api.listEvents(run.id)))
  const messages = runs.map((run, index) => (
    events[index].reduce(
      (history, event) => applyAgentEvent(history, run.id, event),
      [messageFromRun(run)],
    )[0]
  ))
  const activeRun = [...runs].reverse().find((item) => ACTIVE_RUN_STATUSES.has(item.status)) ?? null
  const activeRunIndex = activeRun ? runs.findIndex((item) => item.id === activeRun.id) : -1
  const pendingPermission = activeRunIndex >= 0
    ? pendingPermissionFromEvents(events[activeRunIndex])
    : null
  return { messages, activeRun, pendingPermission }
}

function pendingPermissionFromEvents(events: AgentEvent[]): PendingPermission | null {
  return events.reduce<PendingPermission | null>((pending, event) => {
    if (event.kind === 'permission_requested') return permissionFromEvent(event) ?? pending
    if (event.kind !== 'permission_resolved') return pending
    const requestId = textValue(event.payload.request_id)
    return !requestId || pending?.requestId === requestId ? null : pending
  }, null)
}

function messageFromRun(run: AgentRun): AiAgentMessage {
  return {
    actions: [],
    id: run.id,
    isStreaming: ACTIVE_RUN_STATUSES.has(run.status),
    reasoningDone: !ACTIVE_RUN_STATUSES.has(run.status),
    userMessage: run.message,
  }
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
    if (event.kind === 'tool_started' || event.kind === 'tool_updated') {
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

function permissionFromEvent(event: AgentEvent): PendingPermission | null {
  const requestId = textValue(event.payload.request_id)
  if (!requestId || !Array.isArray(event.payload.options)) return null
  const options = event.payload.options.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const option = value as Record<string, unknown>
    const id = textValue(option.id)
    const label = textValue(option.label)
    if (!id || !label) return []
    return [{ id, label, kind: textValue(option.kind) }]
  })
  return { requestId, tool: textValue(event.payload.tool) || 'Tool', options }
}

function agentName(id: Conversation['agent_id']): string {
  if (id === 'claude_code') return 'Claude Code'
  if (id === 'opencode') return 'OpenCode'
  return 'Codex'
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
