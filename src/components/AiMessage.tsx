import { useState, useCallback } from 'react'
import {
  Brain,
  ChevronDown,
  Copy,
  GitBranch,
  Pencil,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from '@/components/ai-elements/message'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'
import { Checkpoint } from '@/components/ai-elements/checkpoint'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { SessionMarkdown } from '@/kubecode/session/SessionMarkdown'
import { AiActionCard, type AiActionStatus } from './AiActionCard'
import { translate, type AppLocale } from '../lib/i18n'
import type { NoteReference } from '../utils/ai-context'
import type { AiResponseBlock } from '../lib/aiAgentConversation'
import { writeClipboardText } from '../utils/clipboardText'

export interface AiAction {
  tool: string
  toolId: string
  label: string
  path?: string
  status: AiActionStatus
  input?: string
  output?: string
}

export interface AiMessageProps {
  userMessage: string
  references?: NoteReference[]
  localMarker?: string
  locale?: AppLocale
  messageId?: string
  reasoning?: string
  reasoningDone?: boolean
  actions: AiAction[]
  response?: string
  responseBlocks?: AiResponseBlock[]
  isStreaming?: boolean
  internal?: boolean
  onFork?: (messageId: string) => void
  forkUnavailableLabel?: string
  onEdit?: (messageId: string, userMessage: string) => void
  onOpenNote?: (path: string) => void
  onNavigateWikilink?: (target: string) => void
  onRegenerate?: (messageId: string) => void
}

function LocalMarker({ text }: { text: string }) {
  return (
    <Checkpoint className="mb-4 mt-2" data-testid="ai-local-marker" role="note">
      <span className="shrink-0 text-xs">{text}</span>
    </Checkpoint>
  )
}

function ReferencePill({ reference, onClick }: {
  reference: NoteReference
  onClick?: (path: string) => void
}) {
  return (
    <Badge asChild variant="secondary">
      <button
        data-testid="message-reference-pill"
        type="button"
        onClick={() => onClick?.(reference.path)}
      >
        {reference.title}
      </button>
    </Badge>
  )
}

function UserBubble({ content, locale, messageId, onEdit, references, onOpenNote }: {
  content: string
  locale: AppLocale
  messageId?: string
  onEdit?: (messageId: string, userMessage: string) => void
  references?: NoteReference[]
  onOpenNote?: (path: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const submit = () => {
    const message = draft.trim()
    if (!message || !messageId || !onEdit) return
    setEditing(false)
    onEdit(messageId, message)
  }

  if (editing) {
    return (
      <div className="kubecode-session-prompt-editor flex flex-col items-end">
        <form
          className="flex w-full max-w-[85%] flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Textarea
            aria-label={translate(locale, 'ai.message.edit')}
            autoFocus
            className="max-h-48 min-h-20"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false)
            }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
              {translate(locale, 'kubecode.cancel')}
            </Button>
            <Button disabled={!draft.trim()} size="sm" type="submit">
              {translate(locale, 'kubecode.regenerate')}
            </Button>
          </div>
        </form>
      </div>
    )
  }

  const copyLabel = translate(locale, 'ai.message.copyMessage')
  const editLabel = translate(locale, 'ai.message.edit')
  return (
    <Message className="kubecode-session-prompt" from="user">
      <MessageContent className="kubecode-session-prompt-content">
        {references && references.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {references.map(ref => (
              <ReferencePill key={ref.path} reference={ref} onClick={onOpenNote} />
            ))}
          </div>
        )}
        {content}
      </MessageContent>
      <MessageActions className="justify-end self-end" data-testid="ai-user-message-actions">
        <MessageAction
          aria-label={copyLabel}
          label={copyLabel}
          size="icon-xs"
          title={copyLabel}
          onClick={() => {
            void writeClipboardText(content).catch((error) => {
              console.warn('[ai] Failed to copy user message:', error)
            })
          }}
        >
          <Copy aria-hidden size={15} />
        </MessageAction>
        <MessageAction
          aria-label={editLabel}
          disabled={!messageId || !onEdit}
          label={editLabel}
          size="icon-xs"
          title={editLabel}
          onClick={() => {
            setDraft(content)
            setEditing(true)
          }}
        >
          <Pencil aria-hidden size={15} />
        </MessageAction>
      </MessageActions>
    </Message>
  )
}

/** Rendered for the slice's state tests as well as the message body. */
export function ReasoningBlock({ locale, text, done, open, onOpenChange }: {
  locale: AppLocale; text: string; done: boolean; open: boolean; onOpenChange: (open: boolean) => void
}) {
  const label = translate(locale, 'ai.message.reasoning')
  return (
    <Reasoning
      className="kubecode-session-reasoning"
      // Open and closed are Kubecode's (open while it streams, closed once
      // done, the reader's toggle wins); the element's own timers stay off.
      open={open}
      onOpenChange={onOpenChange}
    >
      <ReasoningTrigger data-testid="reasoning-toggle">
        {/* Kubecode (ADR 0257, slice E2): the glyph settles as the reasoning
            ends. No elapsed label — the model carries no started-at to time
            one from, and none is invented. */}
        <Brain
          aria-hidden
          className={done ? 'size-4 animate-in fade-in zoom-in-90 duration-200 motion-reduce:animate-none' : 'size-4'}
          data-state={done ? 'done' : 'streaming'}
        />
        {done ? <span>{label}</span> : <Shimmer as="span" duration={1}>{label}</Shimmer>}
        <ChevronDown aria-hidden className="kubecode-session-reasoning-caret" size={12} />
      </ReasoningTrigger>
      <ReasoningContent data-testid="reasoning-content">
        {text}
      </ReasoningContent>
    </Reasoning>
  )
}

function ToolUseBlock({
  actions,
  expanded,
  expandedActionIds,
  locale,
  onOpenNote,
  onToggle,
  onToggleAction,
}: {
  actions: AiAction[]
  expanded: boolean
  expandedActionIds: Set<string>
  locale: AppLocale
  onOpenNote?: (path: string) => void
  onToggle: () => void
  onToggleAction: (toolId: string) => void
}) {
  const pending = actions.some((action) => action.status === 'pending')

  return (
    <Collapsible className="kubecode-session-tool-use" open={expanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <Button
          className="kubecode-session-tool-use-toggle"
          data-testid="tool-use-toggle"
          size="sm"
          type="button"
          variant="ghost"
        >
          <Terminal aria-hidden size={14} />
          <span>{translate(locale, 'ai.message.toolUse')}</span>
          <Badge
            data-pending={pending || undefined}
            data-testid="tool-use-count"
            variant="secondary"
          >
            {pending && <Spinner aria-hidden />}
            {actions.length}
          </Badge>
          <ChevronDown aria-hidden className="kubecode-session-tool-use-caret" size={12} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1" data-testid="tool-use-content">
        {actions.map((action) => (
          <AiActionCard
            expanded={expandedActionIds.has(action.toolId)}
            input={action.input}
            key={action.toolId}
            label={action.label}
            locale={locale}
            output={action.output}
            path={action.path}
            status={action.status}
            tool={action.tool}
            onOpenNote={onOpenNote}
            onToggle={() => onToggleAction(action.toolId)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ResponseActions({
  locale,
  messageId,
  onCopy,
  onFork,
  forkUnavailableLabel,
  onRegenerate,
}: {
  locale: AppLocale
  messageId?: string
  onCopy: () => void
  onFork?: (messageId: string) => void
  forkUnavailableLabel?: string
  onRegenerate?: (messageId: string) => void
}) {
  const regenerateDisabled = !messageId || !onRegenerate
  const forkDisabled = !messageId || !onFork
  const forkTitle = forkDisabled && forkUnavailableLabel
    ? forkUnavailableLabel
    : translate(locale, 'ai.message.fork')
  const regenerate = translate(locale, 'ai.message.regenerate')
  const copy = translate(locale, 'ai.message.copy')

  return (
    <MessageActions data-testid="ai-message-actions">
      <MessageAction
        aria-label={regenerate}
        data-testid="ai-message-regenerate"
        disabled={regenerateDisabled}
        label={regenerate}
        size="icon-xs"
        title={regenerate}
        onClick={() => messageId && onRegenerate?.(messageId)}
      >
        <RefreshCw aria-hidden size={14} />
      </MessageAction>
      <MessageAction
        aria-label={copy}
        data-testid="ai-message-copy"
        label={copy}
        size="icon-xs"
        title={copy}
        onClick={onCopy}
      >
        <Copy aria-hidden size={14} />
      </MessageAction>
      <MessageAction
        aria-label={forkTitle}
        data-testid="ai-message-fork"
        disabled={forkDisabled}
        label={forkTitle}
        size="icon-xs"
        title={forkTitle}
        onClick={() => messageId && onFork?.(messageId)}
      >
        <GitBranch aria-hidden size={14} />
      </MessageAction>
    </MessageActions>
  )
}

function ResponseBlock({
  locale,
  messageId,
  onFork,
  onNavigateWikilink,
  onRegenerate,
  forkUnavailableLabel,
  blocks,
  isStreaming,
}: {
  locale: AppLocale
  messageId?: string
  onFork?: (messageId: string) => void
  forkUnavailableLabel?: string
  onNavigateWikilink?: (target: string) => void
  onRegenerate?: (messageId: string) => void
  blocks: AiResponseBlock[]
  isStreaming: boolean
}) {
  const text = blocks.map((block) => block.text).join('\n\n')
  const handleCopy = useCallback(() => {
    void writeClipboardText(text).catch((error) => {
      console.warn('[ai] Failed to copy assistant message:', error)
    })
  }, [text])

  return (
    <Message data-testid="ai-response-block" from="assistant">
      <MessageContent data-testid="ai-response-content">
        {blocks.map((block, index) => (
          <SessionMarkdown
            content={block.text}
            data-testid="ai-response-segment"
            isAnimating={isStreaming && index === blocks.length - 1}
            key={block.id}
            onWikilinkClick={onNavigateWikilink}
          />
        ))}
      </MessageContent>
      <ResponseActions
        locale={locale}
        messageId={messageId}
        onCopy={handleCopy}
        onFork={onFork}
        forkUnavailableLabel={forkUnavailableLabel}
        onRegenerate={onRegenerate}
      />
    </Message>
  )
}

function StreamingIndicator({ locale }: { locale: AppLocale }) {
  return (
    <div className="kubecode-session-working" data-testid="ai-streaming-indicator" role="status">
      <Shimmer as="span" duration={1.5}>{translate(locale, 'kubecode.session.working')}</Shimmer>
    </div>
  )
}

export function AiMessage(props: AiMessageProps) {
  if (props.localMarker) {
    return <LocalMarker text={props.localMarker} />
  }

  return <ConversationMessage {...props} />
}

function ConversationMessage({ userMessage, references, locale = 'en', messageId, reasoning, reasoningDone, actions, response, responseBlocks, isStreaming, internal = false, onEdit, onFork, forkUnavailableLabel, onOpenNote, onNavigateWikilink, onRegenerate }: AiMessageProps) {
  // Manual override: null follows the stream (open while reasoning streams,
  // closed once done); a toggle by the reader wins from then on.
  const [reasoningOverride, setReasoningOverride] = useState<boolean | null>(null)
  const [expandedActions, setExpandedActions] = useState<Set<string>>(new Set())
  const [toolUseExpanded, setToolUseExpanded] = useState(false)

  const reasoningExpanded = reasoningOverride ?? !reasoningDone
  const renderedResponseBlocks = responseBlocks?.length
    ? responseBlocks
    : response ? [{ id: `${messageId ?? 'response'}-legacy`, text: response }] : []

  const toggleAction = useCallback((toolId: string) => {
    setExpandedActions(prev => {
      const next = new Set(prev)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })
  }, [])

  return (
    <div className="kubecode-session-turn min-w-0 max-w-full" data-testid="ai-message">
      {!internal && (
        <UserBubble content={userMessage} locale={locale} messageId={messageId} onEdit={onEdit} references={references} onOpenNote={onOpenNote} />
      )}
      {reasoning && (
        <ReasoningBlock
          done={Boolean(reasoningDone)}
          locale={locale}
          open={reasoningExpanded}
          text={reasoning}
          onOpenChange={setReasoningOverride}
        />
      )}
      {actions.length > 0 && (
        <ToolUseBlock
          actions={actions}
          expanded={toolUseExpanded}
          expandedActionIds={expandedActions}
          locale={locale}
          onOpenNote={onOpenNote}
          onToggle={() => setToolUseExpanded((current) => !current)}
          onToggleAction={toggleAction}
        />
      )}
      {renderedResponseBlocks.length > 0 && (
        <ResponseBlock
          blocks={renderedResponseBlocks}
          locale={locale}
          messageId={messageId}
          onFork={internal ? undefined : onFork}
          forkUnavailableLabel={internal ? undefined : forkUnavailableLabel}
          onNavigateWikilink={onNavigateWikilink}
          onRegenerate={internal ? undefined : onRegenerate}
          isStreaming={Boolean(isStreaming)}
        />
      )}
      {isStreaming && renderedResponseBlocks.length === 0 && <StreamingIndicator locale={locale} />}
    </div>
  )
}
