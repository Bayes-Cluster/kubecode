import { FileText } from 'lucide-react'

import { isEmoji } from '@/utils/emoji'

import type { IconSource } from './Icon'
import { ICON_SIZES } from './index'

export const EMOJI_ICON_BOX_CLASS = 'kubecode-emoji-identity'

export interface EmojiIconProps {
  /** Raw persisted identity value: an emoji, a kebab-case icon name, or empty. */
  value: string | null | undefined
  /** Glyph rendered when the value is missing or not a single emoji. */
  fallback?: IconSource
  /** Accessible label; when omitted the box is decorative. */
  label?: string
  className?: string
}

/**
 * Renders a native-emoji identity inside the fixed 24x24 identity box
 * (20px glyph). Non-emoji values — kebab-case legacy icon names, empty
 * strings — fall back to a lucide glyph so the box never renders empty.
 */
export function EmojiIcon({ value, fallback = FileText, label, className }: EmojiIconProps) {
  const Fallback = fallback
  const emoji = value?.trim() ?? ''
  const showsEmoji = emoji !== '' && isEmoji(emoji)

  return (
    <span
      className={className ? `${EMOJI_ICON_BOX_CLASS} ${className}` : EMOJI_ICON_BOX_CLASS}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      data-shows-emoji={showsEmoji ? 'true' : 'false'}
    >
      {showsEmoji ? (
        <span aria-hidden="true">{emoji}</span>
      ) : (
        <Fallback size={ICON_SIZES.toolbar} aria-hidden="true" focusable="false" />
      )}
    </span>
  )
}
