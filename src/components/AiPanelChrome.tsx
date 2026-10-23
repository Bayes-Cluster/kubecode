import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Sparkle } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import {
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { InputGroup } from '@/components/ui/input-group'
import { AiMessage } from './AiMessage'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { FieldDescription, FieldError } from '@/components/ui/field'
import { StopButton } from '@/components/workspace/SendButton'
import { ICON_SIZES } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { WikilinkChatInput } from './WikilinkChatInput'
import { extractInlineWikilinkReferences } from './inlineWikilinkText'
import { createTranslator, type AppLocale, type Translator } from '../lib/i18n'
import type { AiAgentMessage } from '../lib/aiAgentConversation'
import type { AiAgentReadiness } from '../lib/aiAgents'
import type { NoteReference } from '../utils/ai-context'
import type { VaultEntry } from '../types'
import { scrollBehavior } from '@/lib/reducedMotion'
import { cn } from '@/lib/utils'

interface AiPanelMessageHistoryProps {
  agentLabel: string
  agentReadiness: AiAgentReadiness
  locale?: AppLocale
  messages: AiAgentMessage[]
  isActive: boolean
  leadingContent?: ReactNode
  onForkMessage?: (messageId: string) => void
  forkUnavailableLabel?: string
  onEditMessage?: (messageId: string, userMessage: string) => void
  onOpenNote?: (path: string) => void
  onNavigateWikilink?: (target: string) => void
  onRegenerateMessage?: (messageId: string) => void
  onScrollStateChange?: (scrolled: boolean) => void
  hasContext: boolean
}

interface AiPanelComposerProps {
  activeSendLabel?: string
  entries: VaultEntry[]
  agentLabel: string
  agentReadiness: AiAgentReadiness
  disabled?: boolean
  disabledPlaceholder?: string
  locale?: AppLocale
  input: string
  inputRef: React.RefObject<HTMLDivElement | null>
  isActive: boolean
  controls?: ReactNode
  leadingControl?: ReactNode
  inputContent?: ReactNode
  sendDisabled?: boolean
  statusMessage?: string
  onChange: (value: string) => void
  onActiveSend?: (text: string, references: NoteReference[]) => void
  onSend: (text: string, references: NoteReference[]) => void
  /** Ends the run; a returned promise keeps Stop busy until it settles. */
  onStop: () => void | Promise<unknown>
  onUnsupportedAiPaste?: (message: string) => void
}

function getComposerPlaceholder(
  agentLabel: string,
  agentReadiness: AiAgentReadiness,
  t: Translator,
): string {
  if (agentReadiness === 'checking') {
    return t('ai.panel.placeholder.checking')
  }

  if (agentReadiness === 'missing') {
    return t('ai.panel.placeholder.missing', { agent: agentLabel })
  }

  return t('ai.panel.placeholder.ready', { agent: agentLabel })
}

function ComposerInput({
  disabled,
  entries,
  hasControls,
  input,
  inputRef,
  onChange,
  onSend,
  onUnsupportedAiPaste,
  placeholder,
}: {
  disabled: boolean
  entries: VaultEntry[]
  hasControls: boolean
  input: string
  inputRef: React.RefObject<HTMLDivElement | null>
  onChange: (value: string) => void
  onSend: (text: string, references: NoteReference[]) => void
  onUnsupportedAiPaste?: (message: string) => void
  placeholder: string
}) {
  return (
    <WikilinkChatInput
      entries={entries}
      value={input}
      onChange={onChange}
      onSend={onSend}
      onUnsupportedPaste={onUnsupportedAiPaste}
      disabled={disabled}
      placeholder={placeholder}
      placeholderClassName={hasControls
        ? 'kubecode-composer-placeholder px-2 py-1.5 leading-5'
        : undefined}
      inputRef={inputRef}
      editorClassName={cn(
        'overflow-y-auto overscroll-contain',
        hasControls
          ? 'kubecode-composer-editor min-h-[32px] max-h-[184px] border-0 px-2 py-1.5 leading-5'
          : 'min-h-0 max-h-24',
      )}
      editorStyle={hasControls ? {
        maxHeight: 184,
        minHeight: 32,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      } : { maxHeight: 96, overflowY: 'auto', overscrollBehavior: 'contain' }}
    />
  )
}

const SendIcon = WORKSPACE_COMMAND_ICONS.send.Icon

function ComposerSendButton({
  canSend,
  entries,
  input,
  label,
  onSend,
}: {
  canSend: boolean
  entries: VaultEntry[]
  input: string
  label: string
  onSend: (text: string, references: NoteReference[]) => void
}) {
  // The official Prompt Input submit, with the shared arrow glyph and a
  // localized name (ADR 0245); it sends through the composer's own handler.
  return (
    <PromptInputSubmit
      aria-label={label}
      className="kubecode-send-button"
      data-can-send={canSend}
      data-testid="agent-send"
      disabled={!canSend}
      title={label}
      type="button"
      variant="ghost"
      onClick={() => onSend(input, extractInlineWikilinkReferences(input, entries))}
    >
      <SendIcon aria-hidden size={ICON_SIZES.default} />
    </PromptInputSubmit>
  )
}

/** Busy while its stop is in flight; a stop that failed is announced and can be tried again. */
function ComposerStopButton({
  failedLabel,
  label,
  onStop,
}: {
  failedLabel: string
  label: string
  onStop: () => void | Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const stop = () => {
    if (busy) return
    setBusy(true)
    setAnnouncement('')
    new Promise((resolve) => resolve(onStop()))
      .then(() => setBusy(false), () => {
        setBusy(false)
        setAnnouncement(failedLabel)
      })
  }
  return (
    <>
      <StopButton busy={busy} label={label} testId="agent-stop" onStop={stop} />
      <span className="sr-only" role="status">{announcement}</span>
    </>
  )
}

function AiPanelEmptyState({
  agentLabel,
  agentReadiness,
  hasContext,
  locale = 'en',
}: Pick<AiPanelMessageHistoryProps, 'agentLabel' | 'agentReadiness' | 'hasContext' | 'locale'>) {
  const t = createTranslator(locale)
  const [title, description] = agentReadiness === 'checking'
    ? [t('ai.panel.empty.checkingTitle'), t('ai.panel.empty.checkingDescription')]
    : agentReadiness === 'missing'
      ? [t('ai.panel.empty.missingTitle', { agent: agentLabel }), t('ai.panel.empty.missingDescription')]
      : hasContext
        ? [t('ai.panel.empty.withContextTitle', { agent: agentLabel }), t('ai.panel.empty.withContextDescription')]
        : [t('ai.panel.empty.noContextTitle', { agent: agentLabel }), t('ai.panel.empty.noContextDescription')]

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><Sparkle /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** The reading column: centred, the chat width, with breathing room above and below. */
const HISTORY_LAYOUT = 'mx-auto w-full max-w-(--chat-content-max) px-2.5 pt-5 pb-3'

export const AiPanelMessageHistory = memo(function AiPanelMessageHistory({
  agentLabel,
  agentReadiness,
  locale = 'en',
  messages,
  isActive,
  leadingContent,
  onForkMessage,
  forkUnavailableLabel,
  onEditMessage,
  onOpenNote,
  onNavigateWikilink,
  onRegenerateMessage,
  onScrollStateChange,
  hasContext,
}: AiPanelMessageHistoryProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const autoFollowRef = useRef(true)
  // Mirrors autoFollowRef for rendering: the jump button shows only while
  // the reader has scrolled away from the latest message.
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  const virtualized = messages.length > 100

  const updateScrollState = useCallback(() => {
    const element = containerRef.current
    if (element) {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
      autoFollowRef.current = distanceFromBottom <= 48
      setAwayFromLatest(!autoFollowRef.current)
    }
    onScrollStateChange?.((element?.scrollTop ?? 0) > 1)
  }, [onScrollStateChange])

  const jumpToLatest = useCallback(() => {
    autoFollowRef.current = true
    setAwayFromLatest(false)
    if (virtualized) {
      virtuosoRef.current?.scrollToIndex({ align: 'end', behavior: scrollBehavior(), index: 'LAST' })
      return
    }
    const element = containerRef.current
    if (element) element.scrollTo({ behavior: scrollBehavior(), top: element.scrollHeight })
  }, [virtualized])

  const jumpLabel = createTranslator(locale)('kubecode.session.jumpToLatest')
  // ConversationScrollButton's affordance for a virtualised history: the
  // official button needs use-stick-to-bottom's context, which the virtual
  // list replaces, so the same control is wired to autoFollowRef (ADR 0245).
  const jumpButton = awayFromLatest && messages.length > 0 ? (
    <Button
      aria-label={jumpLabel}
      className="kubecode-session-jump rounded-full"
      data-testid="ai-jump-to-latest"
      size="icon"
      title={jumpLabel}
      type="button"
      variant="outline"
      onClick={jumpToLatest}
    >
      <ArrowDown aria-hidden size={16} />
    </Button>
  ) : null

  useEffect(() => {
    if (messages.length > 100) return
    const followLatestMessage = () => {
      const element = containerRef.current
      if (element && autoFollowRef.current) element.scrollTop = element.scrollHeight
      updateScrollState()
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      followLatestMessage()
      return
    }
    const frame = window.requestAnimationFrame(followLatestMessage)
    return () => window.cancelAnimationFrame(frame)
  }, [messages, isActive, updateScrollState])

  if (virtualized) {
    return (
      <>
      <Virtuoso
        ref={virtuosoRef}
        className={cn(HISTORY_LAYOUT, 'kubecode-virtual-message-history')}
        components={{
          Header: () => <>{leadingContent}</>,
        }}
        data={messages}
        data-testid="ai-message-history"
        firstItemIndex={1_000_000 - messages.length}
        followOutput={(isAtBottom) => (isActive && isAtBottom ? 'auto' : false)}
        increaseViewportBy={{ top: 600, bottom: 800 }}
        initialTopMostItemIndex={messages.length - 1}
        itemContent={(index, message) => (
          <AiMessage
            key={message.id ?? index}
            {...message}
            locale={locale}
            messageId={message.id}
            onEdit={onEditMessage}
            onFork={message.isStreaming ? undefined : onForkMessage}
            forkUnavailableLabel={forkUnavailableLabel}
            onOpenNote={onOpenNote}
            onNavigateWikilink={onNavigateWikilink}
            onRegenerate={onRegenerateMessage}
          />
        )}
        atBottomStateChange={(atBottom) => {
          autoFollowRef.current = atBottom
          setAwayFromLatest(!atBottom)
          onScrollStateChange?.(!atBottom)
        }}
      />
      {jumpButton}
      </>
    )
  }

  return (
    <>
    <div
      ref={containerRef}
      className={cn(HISTORY_LAYOUT, 'kubecode-message-history min-h-0 flex-1 overflow-y-auto overscroll-contain')}
      data-testid="ai-message-history"
      style={{ overflowAnchor: 'none' }}
      onScroll={updateScrollState}
    >
      {leadingContent}
      {messages.length === 0 && !isActive && (
        <AiPanelEmptyState
          agentLabel={agentLabel}
          agentReadiness={agentReadiness}
          locale={locale}
          hasContext={hasContext}
        />
      )}
      {messages.map((message, index) => (
        <AiMessage
          key={message.id ?? index}
          {...message}
          locale={locale}
          messageId={message.id}
          onEdit={onEditMessage}
          onFork={onForkMessage}
          onOpenNote={onOpenNote}
          onNavigateWikilink={onNavigateWikilink}
          onRegenerate={onRegenerateMessage}
        />
      ))}
    </div>
    {jumpButton}
    </>
  )
})

export function AiPanelComposer({
  activeSendLabel,
  entries,
  agentLabel,
  agentReadiness,
  disabled = false,
  disabledPlaceholder,
  locale = 'en',
  input,
  inputRef,
  isActive,
  controls,
  leadingControl,
  inputContent,
  sendDisabled = false,
  statusMessage,
  onChange,
  onActiveSend,
  onSend,
  onStop,
  onUnsupportedAiPaste,
}: AiPanelComposerProps) {
  const t = createTranslator(locale)
  const inputDisabled = disabled || agentReadiness !== 'ready'
  const hasDraft = input.trim().length > 0
  // While a run is active the composer stays live (#97): a non-empty draft
  // sends (queueing server-side) and Stop remains one click away.
  const canSend = !inputDisabled && !sendDisabled && hasDraft
  const canActiveSend = isActive
    && !inputDisabled
    && !sendDisabled
    && Boolean(onActiveSend)
    && hasDraft
  const placeholder = disabled && disabledPlaceholder
    ? disabledPlaceholder
    : isActive && hasDraft
      ? t('ai.panel.placeholder.queued', { agent: agentLabel })
      : getComposerPlaceholder(agentLabel, agentReadiness, t)
  const hasControls = (controls !== undefined && controls !== null)
    || (leadingControl !== undefined && leadingControl !== null)
  const sendButton = isActive
    ? (
        <div className="flex shrink-0 items-center gap-1">
          {/* Stopping the run is its own control, apart from sending (ADR 0227). */}
          <ComposerStopButton
            failedLabel={t('kubecode.composer.stopFailed', { target: agentLabel })}
            label={t('kubecode.composer.stopTarget', { target: agentLabel })}
            onStop={onStop}
          />
          {onActiveSend && (
            <ComposerSendButton
              canSend={canActiveSend}
              entries={entries}
              input={input}
              label={activeSendLabel ?? t('ai.panel.send')}
              onSend={onActiveSend}
            />
          )}
          {!onActiveSend && (
            <ComposerSendButton
              canSend={canSend}
              entries={entries}
              input={input}
              label={t('ai.panel.send')}
              onSend={onSend}
            />
          )}
        </div>
      )
    : (
        <ComposerSendButton
          canSend={canSend}
          entries={entries}
          input={input}
          label={t('ai.panel.send')}
          onSend={onSend}
        />
      )

  return (
    <div className="flex shrink-0 flex-col gap-1">
      {disabled && disabledPlaceholder && (
        <FieldDescription className="px-2">{disabledPlaceholder}</FieldDescription>
      )}
      {statusMessage && (
        <FieldError className="px-2" role="status">{statusMessage}</FieldError>
      )}
      <InputGroup
        className={cn(
          'kubecode-session-prompt-input h-auto',
          hasControls
            ? 'max-h-[202px] min-h-[50px] items-end gap-1 overflow-visible px-2 py-1.5'
            : 'items-end gap-2',
        )}
        data-layout={hasControls ? 'single-row' : undefined}
        data-testid="agent-composer-surface"
      >
        {hasControls && leadingControl && (
          <PromptInputTools className="shrink-0">{leadingControl}</PromptInputTools>
        )}
        <PromptInputBody className="overflow-visible">
          <div className="min-w-0 flex-1 overflow-visible">
            {inputContent ?? <ComposerInput
              disabled={inputDisabled}
              entries={entries}
              hasControls={hasControls}
              input={input}
              inputRef={inputRef}
              onChange={onChange}
              onSend={(text, references) => {
                if (inputDisabled) return
                if (isActive) {
                  // A side question keeps its dedicated send; plain drafts queue
                  // for the next turn (#97). Slash drafts stay untouched while a
                  // run is active — the command menu owns them.
                  if (onActiveSend) onActiveSend(text, references)
                  else if (!text.startsWith('/')) onSend(text, references)
                } else {
                  onSend(text, references)
                }
              }}
              onUnsupportedAiPaste={onUnsupportedAiPaste}
              placeholder={placeholder}
            />}
          </div>
        </PromptInputBody>
        {hasControls && <PromptInputTools className="min-w-0 shrink overflow-hidden">{controls}</PromptInputTools>}
        {sendButton}
      </InputGroup>
    </div>
  )
}
