import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import {
  filterMentions,
  insertMention,
  mentionQueryAt,
  type MentionOption,
} from './mentions'
import { SendButton, StopButton } from './SendButton'

export type ComposerProps = {
  /** Accessible name of the text box. */
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  /** Called when the draft is submitted (Enter, or the send button). */
  onSend: () => void | Promise<void>
  sendLabel: string
  /** Defaults to "the draft has text". Callers add their own conditions. */
  canSend?: boolean
  /** A send is in flight. It is not "agents are working": sending stays available then. */
  busy?: boolean
  disabled?: boolean
  rows?: number
  /** Members that can be mentioned with `@`. */
  mentions?: MentionOption[]
  mentionLabel?: string
  /** Stops one named task or agent. Never replaces the send button. */
  stop?: { label: string; onStop: () => void }
  /** Chips or references shown above the text box. */
  above?: ReactNode
  /** Controls before the send button: attach, intent, and the like. */
  controls?: ReactNode
  /** Hints and errors below the row. */
  below?: ReactNode
  className?: string
  testId?: string
}

/**
 * The composition surface shared by General and direct messages: text,
 * `@mentions`, a row of caller-supplied controls, an arrow send button, and an
 * optional named stop. It owns keyboard and IME behavior (Enter sends,
 * Shift+Enter breaks the line, and nothing is sent while an input method is
 * composing) so every conversation behaves the same. What a message *means*
 * — routing, intents, references — stays with the caller.
 */
export function Composer({
  above,
  busy = false,
  canSend,
  className,
  controls,
  disabled = false,
  label,
  mentionLabel,
  mentions = [],
  onChange,
  onSend,
  placeholder,
  rows = 3,
  sendLabel,
  stop,
  testId,
  below,
  value,
}: ComposerProps) {
  const listId = useId()
  const area = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)

  const typing = mentions.length > 0 ? mentionQueryAt(value, caret) : null
  const candidates = typing ? filterMentions(mentions, typing.query) : []
  const menuOpen = typing !== null && candidates.length > 0 && dismissed !== typing.start
  const highlighted = Math.min(active, Math.max(candidates.length - 1, 0))
  const ready = !disabled && (canSend ?? value.trim().length > 0)

  const choose = (option: MentionOption) => {
    if (!typing) return
    const { text, caret: next } = insertMention(value, typing.start, caret, option.handle)
    onChange(text)
    setCaret(next)
    setActive(0)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(next, next)
    })
  }

  const submit = () => {
    if (ready && !busy) void onSend()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An input method confirming a candidate also presses Enter: not a send.
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((highlighted + step + candidates.length) % candidates.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
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
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      submit()
    }
  }

  const track = (target: HTMLTextAreaElement) => {
    setCaret(target.selectionStart ?? target.value.length)
  }

  return (
    <div className={cn('kubecode-composer', className)} data-testid={testId}>
      {above}
      <div className="kubecode-composer-field">
        {menuOpen && (
          <ul
            aria-label={mentionLabel}
            className="kubecode-mention-menu"
            id={listId}
            role="listbox"
          >
            {candidates.map((option, index) => (
              <li
                aria-selected={index === highlighted}
                id={`${listId}-${option.id}`}
                key={option.id}
                role="option"
                onMouseDown={(event) => {
                  // Keep focus in the text box while choosing.
                  event.preventDefault()
                  choose(option)
                }}
              >
                <strong>@{option.handle}</strong>
                <span>{option.label}</span>
                {option.detail && <small>{option.detail}</small>}
              </li>
            ))}
          </ul>
        )}
        <Textarea
          aria-activedescendant={menuOpen ? `${listId}-${candidates[highlighted].id}` : undefined}
          aria-autocomplete={mentions.length > 0 ? 'list' : undefined}
          aria-controls={menuOpen ? listId : undefined}
          aria-expanded={mentions.length > 0 ? menuOpen : undefined}
          aria-label={label}
          disabled={disabled}
          placeholder={placeholder}
          ref={area}
          role={mentions.length > 0 ? 'combobox' : undefined}
          rows={rows}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            track(event.target)
            setActive(0)
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
      </div>
      <div className="kubecode-composer-row">
        <div className="kubecode-composer-controls">{controls}</div>
        {stop && <StopButton label={stop.label} onStop={stop.onStop} />}
        <SendButton busy={busy} canSend={ready} label={sendLabel} onSend={submit} />
      </div>
      {below}
    </div>
  )
}
