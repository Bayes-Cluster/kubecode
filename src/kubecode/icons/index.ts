/**
 * Semantic icon system primitives (ADR 0209).
 *
 * Sizes are picked by role, not by call site, so every surface renders the
 * same ladder: 12 status, 14 secondary inline, 16 default, 20 toolbar,
 * 24 identity container, 28 minimum hit target.
 */
export const ICON_SIZES = {
  status: 12,
  secondary: 14,
  default: 16,
  toolbar: 20,
  identity: 24,
  hitTarget: 28,
} as const

export type IconSizeKey = keyof typeof ICON_SIZES

export type IconRole =
  | 'navigation'
  | 'command'
  | 'control'
  | 'status'
  | 'identity'
  | 'file'

export type { IconProps, IconSource } from './Icon'
export { Icon } from './Icon'
export type { EmojiIconProps } from './EmojiIcon'
export { EmojiIcon } from './EmojiIcon'
