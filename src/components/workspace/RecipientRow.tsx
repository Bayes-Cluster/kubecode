import { useLayoutEffect, useRef, type ReactNode } from 'react'

import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'

import { MemberIdentity, type MemberRoleKind } from './MemberIdentity'
import type { StatusTone } from './StatusBadge'

export type Recipient = {
  key: string
  name: string
  handle?: string
  role: MemberRoleKind
  roleLabel?: string
  attention?: { label: string; tone: StatusTone }
  /** Takes the recipient off the draft; the row moves focus on. */
  onRemove?: () => void
  /** Names the removal, for example "Don't send to Writer". */
  removeLabel?: string
}

export type RecipientRowProps = {
  /** "To". */
  label: string
  recipients: Recipient[]
  /** What is shown when the draft names no one, for example "General · Project manager". */
  empty?: ReactNode
  /** Focus goes here once the last recipient is removed (usually the text box). */
  onFocusAfterLast?: () => void
}

/**
 * Whom a draft is going to, shown before it is sent (ADR 0229 §4): each
 * recipient in the shared identity, each removable. Removing one moves focus
 * to the next, or past the row once none is left.
 */
export function RecipientRow({ empty, label, onFocusAfterLast, recipients }: RecipientRowProps) {
  const list = useRef<HTMLUListElement>(null)
  const focusAt = useRef<number | null>(null)
  const count = recipients.length

  useLayoutEffect(() => {
    const index = focusAt.current
    if (index === null) return
    focusAt.current = null
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('.kubecode-recipient-remove') ?? []
    const next = buttons[Math.min(index, buttons.length - 1)]
    if (next) next.focus()
    else onFocusAfterLast?.()
  }, [count, onFocusAfterLast])

  return (
    <div className="kubecode-composer-to">
      <span aria-hidden="true" className="kubecode-composer-to-label">{label}</span>
      {count === 0 ? (
        <span className="kubecode-composer-to-empty">{empty}</span>
      ) : (
        <ul aria-label={label} className="kubecode-composer-to-list" ref={list}>
          {recipients.map((recipient, index) => (
            <li className="kubecode-recipient" key={recipient.key}>
              <MemberIdentity
                attention={recipient.attention}
                handle={recipient.handle}
                name={recipient.name}
                role={recipient.role}
                roleLabel={recipient.roleLabel}
                size="sm"
              />
              {recipient.onRemove && (
                <button
                  aria-label={recipient.removeLabel}
                  className="kubecode-recipient-remove"
                  type="button"
                  onClick={() => {
                    focusAt.current = index
                    recipient.onRemove?.()
                  }}
                >
                  <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.close.Icon} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
