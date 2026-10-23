import { useCallback } from 'react'

import { CodeBlock } from '@/components/ai-elements/code-block'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import { translate, type AppLocale } from '@/lib/i18n'

export type AiActionStatus = 'pending' | 'done' | 'error'

export interface AiActionCardProps {
  tool: string
  label: string
  path?: string
  status: AiActionStatus
  input?: string
  output?: string
  expanded: boolean
  onToggle: () => void
  onOpenNote?: (path: string) => void
  locale?: AppLocale
}

const MAX_DETAIL_LENGTH = 800

/** The official Tool states for Kubecode's three action states. */
const TOOL_STATE = {
  pending: 'input-available',
  done: 'output-available',
  error: 'output-error',
} as const

const STATUS_LABEL_KEY = {
  pending: 'kubecode.session.toolStatusRunning',
  done: 'kubecode.session.toolStatusDone',
  error: 'kubecode.session.toolStatusFailed',
} as const

function truncateText(text: string): string {
  return text.length <= MAX_DETAIL_LENGTH ? text : `${text.slice(0, MAX_DETAIL_LENGTH)}…`
}

function parseInput(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * One tool call on the official AI Elements Tool (ADR 0245): the header
 * names the call and its state in words, Input shows the parameters, and
 * Output shows what came back in a Code Block, shell output included, and a
 * failed call keeps its output in the same Code Block under an Error heading.
 * The registry now publishes Terminal and Stack Trace; adopting them is
 * recorded as a follow-up in ADR 0253 (Terminal needs a new ANSI dependency,
 * and ACP tool output carries no parsed stack frames to give Stack Trace).
 * A call without details that names a file opens it instead of expanding.
 */
export function AiActionCard({
  tool, label, path, status, input, output, expanded, onToggle, onOpenNote, locale = 'en',
}: AiActionCardProps) {
  const hasDetails = Boolean(input || output)
  const directOpenPath = !hasDetails && path && onOpenNote ? path : null
  const open = hasDetails && expanded

  const handleOpenChange = useCallback(() => {
    if (directOpenPath && onOpenNote) {
      onOpenNote(directOpenPath)
      return
    }
    if (hasDetails) onToggle()
  }, [directOpenPath, hasDetails, onOpenNote, onToggle])

  return (
    <Tool
      className="ai-action-card"
      data-density="compact"
      data-status={status}
      data-testid="ai-action-card"
      open={open}
      onOpenChange={handleOpenChange}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          onToggle()
        }
      }}
    >
      <ToolHeader
        className="ai-action-card-header"
        state={TOOL_STATE[status]}
        statusLabel={translate(locale, STATUS_LABEL_KEY[status])}
        title={label}
        toolName={tool}
        type="dynamic-tool"
      />
      {open && (
        <ToolContent className="ai-action-card-details" data-testid="action-card-details">
          {input && (
            <ToolInput
              data-testid="detail-input"
              input={parseInput(input)}
              label={translate(locale, 'kubecode.session.toolInput')}
            />
          )}
          {output && (
            <ToolOutput
              data-testid="detail-output"
              errorText={undefined}
              output={<CodeBlock code={truncateText(output)} language="log" />}
              resultLabel={status === 'error'
                ? translate(locale, 'kubecode.session.toolError')
                : translate(locale, 'kubecode.session.toolOutput')}
            />
          )}
        </ToolContent>
      )}
    </Tool>
  )
}
