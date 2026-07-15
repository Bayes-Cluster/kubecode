import type { AiAction } from '../components/AiMessage'
import type { NoteReference } from '../utils/ai-context'

export interface AiAgentMessage {
  userMessage: string
  references?: NoteReference[]
  localMarker?: string
  reasoning?: string
  reasoningDone?: boolean
  actions: AiAction[]
  response?: string
  isStreaming?: boolean
  id?: string
}

export type AgentStatus = 'idle' | 'thinking' | 'tool-executing' | 'done' | 'error'
