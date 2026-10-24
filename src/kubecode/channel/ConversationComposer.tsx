import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'

import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MemberAvatar } from '@/components/workspace/MemberIdentity'
import { filterMentions, insertMention, mentionQueryAt, type MentionOption } from '@/components/workspace/mentions'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'
import { useCoarsePointer } from './useCoarsePointer'

export type ConversationComposerProps = {
  /** Accessible name of the text box. */
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  /** Called when the draft is submitted (Enter, or the send button). */
  onSend: () => void
  sendLabel: string
  /** Names the Prompt Input's hidden file input. */
  attachLabel: string
  /** Defaults to "the draft has text". Callers add their own conditions. */
  canSend?: boolean
  disabled?: boolean
  /** Members that can be mentioned with `@`. */
  mentions?: MentionOption[]
  /** Names the suggestion list; required wherever `mentions` is given. */
  mentionLabel?: string
  /** Stops one named turn. Never replaces the send button. */
  stop?: { label: string; shortLabel?: string; onStop: () => void }
  /** What the message replies to and cites, at the top of the card. */
  header?: ReactNode
  /** Tools before the send button: the Add context menu and the like. */
  tools?: ReactNode
  /** Hints and errors at the foot of the card. */
  notices?: ReactNode
  className?: string
  /** Names the text box for focus return (`data-focus-key`, ADR 0228 §4). */
  focusKey?: string
  textareaRef?: Ref<HTMLTextAreaElement>
  /** Why the draft cannot be sent, said by the send button. */
  sendDisabledReason?: string
}

/** Hands the text box to the ref the caller gave, whichever kind it is. */
function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as { current: T }).current = value
}

/** A touch keyboard has no Shift key: there Enter breaks the line and the arrow sends. */
/**
 * The composer of General and DMs on the official Prompt Input (ADR 0242):
 * `PromptInputTextarea`, `PromptInputTools`, `PromptInputSubmit`, and the
 * `@mention` picker as `PromptInputCommand` (cmdk). It keeps the keyboard and
 * IME contract of ADR 0222: Enter sends, Shift+Enter breaks the line, nothing
 * is sent while an input method composes, and in the picker the arrows move,
 * Enter or Tab (once there is something to complete) chooses and Escape
 * closes it. Focus stays in the text box throughout.
 */
export function ConversationComposer({
  canSend,
  className,
  disabled = false,
  focusKey,
  header,
  label,
  mentionLabel,
  mentions = [],
  notices,
  onChange,
  onSend,
  placeholder,
  sendDisabledReason,
  sendLabel,
  attachLabel,
  stop,
  textareaRef,
  tools,
  value,
}: ConversationComposerProps) {
  const reasonId = useId()
  const area = useRef<HTMLTextAreaElement | null>(null)
  const setArea = useCallback((node: HTMLTextAreaElement | null) => {
    area.current = node
    assignRef(textareaRef, node)
  }, [textareaRef])
  const composing = useRef(false)
  const coarse = useCoarsePointer()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)

  const typing = mentions.length > 0 && !disabled ? mentionQueryAt(value, caret) : null
  const candidates = typing ? filterMentions(mentions, typing.query) : []
  const menuOpen = typing !== null && candidates.length > 0 && dismissed !== typing.start
  const highlighted = Math.min(active, Math.max(candidates.length - 1, 0))
  const ready = !disabled && (canSend ?? value.trim().length > 0)
  const reason = !ready && sendDisabledReason ? sendDisabledReason : null

  // cmdk names its list and options itself: once they are drawn, the text box points at them.
  // The list mounts in a portal after the text box: holding its node in state re-runs the link below once it is there.
  const [menu, setMenu] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const box = area.current
    if (!box) return
    const list = menuOpen ? menu?.querySelector<HTMLElement>('[cmdk-list]')?.id : undefined
    // The highlighted option by its value (set as it is drawn), not by cmdk's selection, which follows a step later.
    const value = menuOpen ? candidates[highlighted]?.id : undefined
    const option = value ? menu?.querySelector<HTMLElement>(`[cmdk-item][data-value="${CSS.escape(value)}"]`)?.id : undefined
    if (list) box.setAttribute('aria-controls', list)
    else box.removeAttribute('aria-controls')
    if (option) box.setAttribute('aria-activedescendant', option)
    else box.removeAttribute('aria-activedescendant')
  })

  // A composition that never ends (focus lost mid-way, the box disabled) must not leave Enter dead.
  useEffect(() => {
    if (disabled) composing.current = false
  }, [disabled])

  const choose = (option: MentionOption) => {
    if (!typing) return
    const { text, caret: next } = insertMention(value, typing.start, caret, option.handle)
    onChange(text)
    setCaret(next)
    setActive(0)
    setNavigated(false)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(next, next)
    })
  }

  const submit = () => {
    if (!ready) return
    onSend()
    area.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An input method confirming a candidate also presses Enter: not a send.
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      // The Prompt Input would submit a late Enter (Safari's 229 after the composition): it is held here.
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault()
      return
    }
    // The caret as the browser has it now, not as last rendered.
    const here = event.currentTarget.selectionStart ?? value.length
    if (here !== caret) setCaret(here)
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((highlighted + step + candidates.length) % candidates.length)
        setNavigated(true)
        return
      }
      const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      // Enter picks the suggestion. Tab picks it only once there is something to
      // complete; an empty "@" must not trap the Tab key.
      if (plain && (event.key === 'Enter' || (event.key === 'Tab' && (navigated || (typing?.query ?? '') !== '')))) {
        event.preventDefault()
        choose(candidates[highlighted])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(typing?.start ?? null)
        return
      }
    }
    if (event.key === 'Enter') {
      // The Prompt Input never submits by itself: the composer decides here.
      if (event.shiftKey || event.altKey) return
      // On a touch keyboard Enter is a line break; the arrow sends. A modifier chord still sends there.
      if (coarse && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        const box = event.currentTarget
        const start = box.selectionStart ?? value.length
        const end = box.selectionEnd ?? start
        const next = `${value.slice(0, start)}\n${value.slice(end)}`
        onChange(next)
        requestAnimationFrame(() => box.setSelectionRange(start + 1, start + 1))
        return
      }
      event.preventDefault()
      submit()
    }
  }

  const track = (target: HTMLTextAreaElement) => {
    setCaret(target.selectionStart ?? target.value.length)
  }

  return (
    // The Prompt Input's buttons name themselves in tooltips.
    <TooltipProvider>
    <Popover
      open={menuOpen}
      onOpenChange={(next) => {
        // Escape or a press outside the list closes it until the researcher types on.
        if (!next) setDismissed(typing?.start ?? null)
      }}
    >
    <PopoverAnchor asChild>
    <div className={cn('kubecode-composer', className)}>
      {menuOpen && (
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-0"
          ref={setMenu}
          side="top"
          // Focus stays in the text box: the list is driven from there.
          onCloseAutoFocus={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <PromptInputCommand
            label={mentionLabel ?? label}
            shouldFilter={false}
            value={candidates[highlighted]?.id ?? ''}
            onValueChange={(id) => {
              const index = candidates.findIndex((option) => option.id === id)
              if (index >= 0) setActive(index)
            }}
          >
            <PromptInputCommandList label={mentionLabel ?? label}>
              <PromptInputCommandGroup>
                {candidates.map((option) => (
                  <PromptInputCommandItem
                   
                    key={option.id}
                    value={option.id}
                    // Keep focus in the text box while choosing.
                    onMouseDown={(event) => event.preventDefault()}
                    onSelect={() => choose(option)}
                  >
                    <MentionRow option={option} />
                  </PromptInputCommandItem>
                ))}
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>
        </PopoverContent>
      )}
      {/* The form never submits on its own: Enter and the send button go through `submit`. */}
      <PromptInput className="kubecode-prompt-input" uploadLabel={attachLabel} onSubmit={() => submit()}>
        {header && <PromptInputHeader className="kubecode-composer-context">{header}</PromptInputHeader>}
        <PromptInputBody>
          <PromptInputTextarea
            aria-autocomplete={mentions.length > 0 ? 'list' : undefined}
            aria-expanded={mentions.length > 0 ? menuOpen : undefined}
            aria-label={label}
            className="kubecode-composer-textarea"
            data-focus-key={focusKey}
            disabled={disabled}
            placeholder={placeholder}
            ref={setArea}
            role={mentions.length > 0 ? 'combobox' : undefined}
            rows={2}
            value={value}
            onBlur={() => {
              // Leaving the box ends any composition that never reported its end.
              composing.current = false
            }}
            onChange={(event) => {
              onChange(event.target.value)
              track(event.target)
              setActive(0)
              setNavigated(false)
              // Typing on means the list is wanted again.
              setDismissed(null)
            }}
            onClick={(event) => track(event.currentTarget)}
            onCompositionEnd={() => { composing.current = false }}
            onCompositionStart={() => { composing.current = true }}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => track(event.currentTarget)}
            onSelect={(event) => track(event.currentTarget)}
          />
        </PromptInputBody>
        <PromptInputFooter className="kubecode-composer-row">
          <PromptInputTools className="kubecode-composer-controls">
            {tools}
            {stop && (
              <PromptInputButton aria-label={stop.label} size="sm" variant="outline" onClick={stop.onStop}>
                <Icon role="status" source={WORKSPACE_COMMAND_ICONS.stopRun.Icon} />
                <span aria-hidden="true" className="pointer-fine:sr-only">{stop.shortLabel ?? stop.label}</span>
              </PromptInputButton>
            )}
          </PromptInputTools>
          {reason && <span className="sr-only" id={reasonId}>{reason}</span>}
          <PromptInputSubmit
            aria-describedby={reason ? reasonId : undefined}
            aria-label={sendLabel}
            disabled={!ready}
            title={sendLabel}
            type="button"
            variant={ready ? 'default' : 'ghost'}
            onClick={submit}
          >
            <Icon role="command" source={WORKSPACE_COMMAND_ICONS.send.Icon} />
          </PromptInputSubmit>
        </PromptInputFooter>
        {notices && <div className="flex flex-col gap-1 self-stretch px-3 pb-2">{notices}</div>}
      </PromptInput>
    </div>
    </PopoverAnchor>
    </Popover>
    </TooltipProvider>
  )
}

/** One suggestion: who the member is, as everywhere (avatar, name, handle, role in words). */
function MentionRow({ option }: { option: MentionOption }) {
  if (!option.identity) {
    return (
      <>
        <strong>@{option.handle}</strong>
        <span>{option.label}</span>
        {option.detail && <small className="ms-auto text-muted-foreground">{option.detail}</small>}
      </>
    )
  }
  return (
    <>
      <MemberAvatar name={option.label} role={option.identity.role} size="sm" />
      <span>{option.label}</span>
      <strong>@{option.handle}</strong>
      {option.identity.roleLabel && <small className="ms-auto text-muted-foreground">{option.identity.roleLabel}</small>}
      {option.identity.unavailable && <small className="text-muted-foreground">{option.identity.unavailable}</small>}
    </>
  )
}
