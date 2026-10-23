import { useId } from 'react'

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@/components/ui/attachment'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_OBJECT_ICONS, type WorkspaceObjectKind } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

export type ReferenceState = {
  /**
   * `changed`: it differs from the cited version; `removed`: it no longer
   * exists; `unavailable`: it cannot be read here (no access, private, or it
   * failed to load).
   */
  kind: 'changed' | 'removed' | 'unavailable'
  label: string
}

type Removal =
  | {
    /**
     * Removes the reference from a draft. The caller moves focus afterwards
     * (to the next chip or the text box), since this chip is gone.
     */
    onRemove: () => void
    /** Names what is removed, for example "Remove results.csv". */
    removeLabel: string
  }
  | { onRemove?: undefined; removeLabel?: undefined }

export type ReferenceChipProps = Removal & {
  kind: WorkspaceObjectKind
  /** The kind in words, for example "Evidence"; read before the title by assistive technology. */
  kindLabel: string
  /** The object's name, never a bare id. */
  title: string
  /** The version that was cited, when the object has versions. */
  version?: string
  /** Whether it changed since it was cited, is gone, or cannot be read, in words. */
  state?: ReferenceState
  /** Opens the object. A chip only ever opens; it never starts or authorizes anything. */
  onOpen?: () => void
  className?: string
}

const STATE_BADGE = { changed: 'warning', removed: 'destructive', unavailable: 'secondary' } as const
const ATTACHMENT_STATE = { changed: 'done', removed: 'error', unavailable: 'idle' } as const

/**
 * One named reference to a Workspace object (ADR 0227): its kind glyph, its
 * title, the cited version, and — in words — whether it changed, is gone, or
 * cannot be read. It is the official Attachment (#258): the media holds the
 * kind glyph, the trigger opens it, the action removes it from a draft. The
 * open trigger is named by the visible text, preceded by the kind.
 */
export function ReferenceChip({
  className,
  kind,
  kindLabel,
  onOpen,
  onRemove,
  removeLabel,
  state,
  title,
  version,
}: ReferenceChipProps) {
  const id = useId()
  // The trigger is named by the chip's own words, part by part, preceded by the kind.
  const labelledBy = [`${id}-kind`, `${id}-title`, version && `${id}-version`, state && `${id}-state`].filter(Boolean).join(' ')
  const opens = onOpen !== undefined && state?.kind !== 'unavailable'
  return (
    // On touch the covering trigger, inside the 1px border, is at least 44px tall.
    <Attachment
      className={cn('kubecode-reference-chip min-w-0 pointer-coarse:min-h-[46px]', className)}
      data-kind={kind}
      data-reference-state={state?.kind ?? 'current'}
      size="xs"
      state={state ? ATTACHMENT_STATE[state.kind] : 'done'}
    >
      <AttachmentMedia>
        <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[kind].Icon} />
      </AttachmentMedia>
      <AttachmentContent>
        <span className="sr-only" id={`${id}-kind`}>{kindLabel} </span>
        <AttachmentTitle
          id={`${id}-title`}
          className={cn('whitespace-normal [overflow-wrap:anywhere]', state?.kind === 'removed' && 'line-through')}
          title={title}
        >
          {title}
        </AttachmentTitle>
        {(version || state) && (
          <AttachmentDescription className="flex flex-wrap items-center gap-1 whitespace-normal">
            {version && <span id={`${id}-version`}>{version}</span>}
            {state && <Badge id={`${id}-state`} variant={STATE_BADGE[state.kind]}>{state.label}</Badge>}
          </AttachmentDescription>
        )}
      </AttachmentContent>
      {opens && (
        // The trigger covers the chip.
        <AttachmentTrigger aria-labelledby={labelledBy} data-reference-chip-action="open" onClick={onOpen} />
      )}
      {onRemove && (
        <AttachmentActions>
          <AttachmentAction
            aria-label={removeLabel}
            className="pointer-coarse:size-[44px]"
            data-reference-chip-action="remove"
            type="button"
            onClick={onRemove}
          >
            <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.close.Icon} />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  )
}
