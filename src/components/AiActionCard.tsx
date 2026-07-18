import { type ReactNode, useCallback } from 'react'
import {
  PencilSimple, MagnifyingGlass,
  CircleNotch, CheckCircle, XCircle, CaretRight, CaretDown,
  Terminal, File, FolderOpen, NotePencil,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

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
}

const MAX_DETAIL_LENGTH = 800

type IconRenderer = (size: number) => ReactNode

const TOOL_ICON_MAP: Record<string, IconRenderer> = {
  // Native Claude Code tools
  Bash: (s) => <Terminal size={s} />,
  Write: (s) => <PencilSimple size={s} />,
  Edit: (s) => <NotePencil size={s} />,
  Read: (s) => <File size={s} />,
  Glob: (s) => <FolderOpen size={s} />,
  Grep: (s) => <MagnifyingGlass size={s} />,
}
const TOOL_ICON_BY_NAME = new Map(Object.entries(TOOL_ICON_MAP))

const DEFAULT_ICON: IconRenderer = (s) => <PencilSimple size={s} />

function StatusIndicator({ status }: { status: AiActionStatus }) {
  if (status === 'pending') {
    return <CircleNotch size={14} className="ai-spin text-muted-foreground" data-testid="status-pending" />
  }
  if (status === 'done') {
    return <CheckCircle size={14} weight="fill" style={{ color: 'var(--accent-green)' }} data-testid="status-done" />
  }
  return <XCircle size={14} weight="fill" style={{ color: 'var(--destructive)' }} data-testid="status-error" />
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DETAIL_LENGTH) return { text, truncated: false }
  return { text: text.slice(0, MAX_DETAIL_LENGTH), truncated: true }
}

function formatInputForDisplay(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function hasActionDetails(input?: string, output?: string): boolean {
  return Boolean(input || output)
}

function resolveDirectOpenPath({
  hasDetails,
  onOpenNote,
  path,
}: Pick<AiActionCardProps, 'onOpenNote' | 'path'> & {
  hasDetails: boolean
}): string | null {
  if (hasDetails || !path || !onOpenNote) return null
  return path
}

function ActionCardHeader({
  expanded,
  hasDetails,
  label,
  onClick,
  renderIcon,
  status,
}: {
  expanded: boolean
  hasDetails: boolean
  label: string
  onClick: () => void
  renderIcon: IconRenderer
  status: AiActionStatus
}) {
  return (
    <Button
      type="button"
      className="ai-action-card-header"
      aria-expanded={hasDetails ? expanded : undefined}
      size="sm"
      variant="ghost"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault()
          onClick()
        }
      }}
      data-testid="action-card-header"
    >
      <span className="ai-action-card-icon" aria-hidden="true">
        {renderIcon(14)}
      </span>
      <span className="ai-action-card-label">{label}</span>
      <StatusIndicator status={status} />
      {hasDetails && (
        <span className="ai-action-card-caret" aria-hidden="true">
          {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </span>
      )}
    </Button>
  )
}

function DetailBlock({ label, content, isError }: {
  label: string; content: string; isError?: boolean
}) {
  const { text, truncated } = truncateText(content)
  return (
    <div style={{ marginTop: 6 }}>
      <div
        className="text-muted-foreground"
        style={{ fontSize: 10, fontWeight: 600, marginBottom: 2 }}
      >
        {label}
      </div>
      <pre
        data-testid={`detail-${label.toLowerCase()}`}
        style={{
          fontSize: 11,
          lineHeight: 1.4,
          margin: 0,
          padding: '4px 6px',
          borderRadius: 4,
          background: 'var(--muted)',
          color: isError ? 'var(--destructive)' : 'var(--foreground)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 200,
          overflow: 'auto',
        }}
      >
        {text}{truncated && <span className="text-muted-foreground">{'…'}</span>}
      </pre>
    </div>
  )
}

function ActionCardDetails({
  expanded,
  hasDetails,
  input,
  output,
  status,
}: {
  expanded: boolean
  hasDetails: boolean
  input?: string
  output?: string
  status: AiActionStatus
}) {
  if (!expanded || !hasDetails) return null

  const formattedInput = input ? formatInputForDisplay(input) : undefined
  return (
    <div
      data-testid="action-card-details"
      style={{ padding: '0 10px 8px 10px' }}
    >
      {formattedInput && <DetailBlock label="Input" content={formattedInput} />}
      {output && (
        <DetailBlock label="Output" content={output} isError={status === 'error'} />
      )}
    </div>
  )
}

export function AiActionCard({
  tool, label, path, status, input, output, expanded, onToggle, onOpenNote,
}: AiActionCardProps) {
  const renderIcon = TOOL_ICON_BY_NAME.get(tool) ?? DEFAULT_ICON
  const hasDetails = hasActionDetails(input, output)
  const directOpenPath = resolveDirectOpenPath({ path, onOpenNote, hasDetails })

  const handleClick = useCallback(() => {
    if (directOpenPath && onOpenNote) {
      onOpenNote(directOpenPath)
      return
    }

    onToggle()
  }, [directOpenPath, onOpenNote, onToggle])

  return (
    <div
      data-testid="ai-action-card"
      className="ai-action-card"
      data-density="compact"
      data-status={status}
    >
      <ActionCardHeader
        expanded={expanded}
        hasDetails={hasDetails}
        label={label}
        onClick={handleClick}
        renderIcon={renderIcon}
        status={status}
      />
      <ActionCardDetails
        expanded={expanded}
        hasDetails={hasDetails}
        input={input}
        output={output}
        status={status}
      />
    </div>
  )
}
