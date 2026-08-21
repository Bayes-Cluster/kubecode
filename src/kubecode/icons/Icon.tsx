import type { ComponentType, SVGAttributes } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { ICON_SIZES } from './index'
import type { IconRole, IconSizeKey } from './index'

/**
 * Any icon renderer that emits a root `<svg>` and accepts a `size` prop —
 * lucide-react components by default, @remixicon/react for filled roles.
 * The root-svg contract keeps the existing `> svg` sizing selectors in
 * kubecode.css working; wrappers that render an intermediate element are
 * not valid sources.
 */
export type IconSource = ComponentType<
  SVGAttributes<SVGSVGElement> & { size?: number | string }
>

export interface IconProps {
  source: IconSource
  /** Semantic role of the icon; selects the default size tier. */
  role: IconRole
  /** Size tier override. Defaults to the role's tier: status 12, identity and file 16, everything else 16 unless noted. */
  size?: IconSizeKey
  /**
   * Accessible label. Unlabeled icons are decorative (`aria-hidden`);
   * labeled icons become `role="img"` with the label repeated as a
   * tooltip.
   */
  label?: string
  className?: string
}

const ROLE_DEFAULT_SIZES: Record<IconRole, IconSizeKey> = {
  navigation: 'default',
  command: 'default',
  control: 'default',
  status: 'status',
  identity: 'default',
  file: 'default',
}

export function Icon({ source, role, size, label, className }: IconProps) {
  const Source = source
  const tier = size ?? ROLE_DEFAULT_SIZES[role]
  const pixels = ICON_SIZES[tier]

  if (!label) {
    return (
      <Source
        size={pixels}
        aria-hidden="true"
        focusable="false"
        data-icon-role={role}
        className={className}
      />
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Source
          size={pixels}
          role="img"
          aria-label={label}
          focusable="false"
          data-icon-role={role}
          className={className}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
