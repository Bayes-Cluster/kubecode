import { resolveDirectoryIcon } from '../resolveFileIcon'

import { MATERIAL_ICONS } from './manifest'
import type { MaterialIconBody, MaterialIconId } from './manifest'

export interface MaterialFileIconProps {
  id: MaterialIconId
  /** Pixel size; file identity defaults to the 16px tier (ADR 0209). */
  size?: number
  /** Accessible label; unlabeled icons are decorative. */
  label?: string
  className?: string
}

/**
 * Renders a vendored Material file/directory icon as a root `<svg>` so the
 * existing `> svg` sizing selectors keep working (ADR 0209). Light theme
 * variants are inlined as a sibling `<g data-variant="light">` and swapped
 * purely via CSS — there is no React theme context to subscribe to.
 */
export function MaterialFileIcon({ id, size = 16, label, className }: MaterialFileIconProps) {
  const icon: MaterialIconBody = MATERIAL_ICONS[id]
  return (
    <svg
      className={className ? `kubecode-material-icon ${className}` : 'kubecode-material-icon'}
      data-material-icon={id}
      viewBox={icon.viewBox}
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      <g data-variant="dark" dangerouslySetInnerHTML={{ __html: icon.dark }} />
      {icon.light !== undefined ? (
        <g data-variant="light" dangerouslySetInnerHTML={{ __html: icon.light }} />
      ) : null}
    </svg>
  )
}

export interface MaterialDirectoryIconProps {
  name: string
  expanded?: boolean
  size?: number
  label?: string
  className?: string
}

/**
 * Directory convenience wrapper: renders the resolved folder icon for
 * `name`, preferring the `-open` companion when expanded. Falls back to
 * the audited generic folder baselines.
 */
export function MaterialDirectoryIcon({
  name,
  expanded = false,
  size = 16,
  label,
  className,
}: MaterialDirectoryIconProps) {
  const id = resolveDirectoryIcon(name, expanded)
  return <MaterialFileIcon id={id} size={size} label={label} className={className} />
}
