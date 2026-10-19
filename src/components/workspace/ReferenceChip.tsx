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

/**
 * One named reference to a Workspace object (ADR 0227): its kind glyph, its
 * title, the cited version, and — in words — whether it changed, is gone, or
 * cannot be read. Its accessible name is its visible text, preceded by the
 * kind.
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
  const content = (
    <>
      <Icon role="identity" size="secondary" source={WORKSPACE_OBJECT_ICONS[kind].Icon} />
      <span className="sr-only">{kindLabel}</span>
      {' '}
      <span className="kubecode-reference-chip-title" title={title}>{title}</span>
      {version && <>{' '}<span className="kubecode-reference-chip-version">{version}</span></>}
      {state && <>{' '}<span className="kubecode-reference-chip-state" title={state.label}>{state.label}</span></>}
    </>
  )
  return (
    <span
      className={cn('kubecode-reference-chip', className)}
      data-kind={kind}
      data-state={state?.kind ?? 'current'}
    >
      {onOpen && state?.kind !== 'unavailable' ? (
        <button className="kubecode-reference-chip-open" type="button" onClick={onOpen}>{content}</button>
      ) : (
        <span className="kubecode-reference-chip-open">{content}</span>
      )}
      {onRemove && (
        <button
          aria-label={removeLabel}
          className="kubecode-reference-chip-remove"
          type="button"
          onClick={onRemove}
        >
          <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.close.Icon} />
        </button>
      )}
    </span>
  )
}
