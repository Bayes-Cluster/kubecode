import type { HTMLAttributes, ReactNode } from 'react'

import './board.css'

/**
 * ADR 0257, adapting the affectUI "Task Board" block
 * (https://www.affectui.com/blocks/task-board, preview captured 2026-10-29)
 * as the one board/column/card presentation for both kanban adapters —
 * Work here (#284), Tasks in #283. Reproduced: the tray columns with their
 * live counts, the ring-framed cards with compact fact chips, the accent
 * drop indicator and the tinted drop target, and the dashed empty lane.
 * Deviations: no breadcrumbs bar and no built-in detail side panel — the
 * board lives inside the Workspace frame (#279) and its inspector stack is
 * the detail surface; no per-card avatars or dates unless the adapter owns
 * that data. The domain stages, allowed moves and admission rules belong
 * entirely to the adapter: nothing here assumes a move is legal.
 *
 * States: `#/controls` (AgentUiMatrix) shows the board's columns, a card in
 * its fact chips, the drop indicator and the empty lane.
 */

/** The board frame: a sideways run of columns that never squeezes a lane. */
export function AgxBoard({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={className ? `agx-board ${className}` : 'agx-board'}>
      {children}
    </div>
  )
}

/** The column run. */
export function AgxBoardColumns({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={className ? `agx-board__columns ${className}` : 'agx-board__columns'}>
      {children}
    </div>
  )
}

/** One tray column: the title, the live count, the drop-target tint. */
export function AgxBoardColumn({
  label,
  count,
  over = false,
  emptyLabel,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  label: ReactNode
  /** The live count from the server projection, not the rendered length. */
  count: ReactNode
  /** A supported move would land here. */
  over?: boolean
  /** What an empty column says, if the adapter says anything. */
  emptyLabel?: ReactNode
  children?: ReactNode
}) {
  const empty = count === 0 || count === '0'
  return (
    <section
      {...props}
      className={className ? `agx-board__column ${className}` : 'agx-board__column'}
      data-over={over ? '' : undefined}
    >
      <header className="agx-board__col-head">
        <h3 className="agx-board__col-title">{label}</h3>
        <span className="agx-board__col-count">{count}</span>
      </header>
      <div className="agx-board__cards">
        {children}
        {empty && emptyLabel !== undefined && <p className="agx-board__empty">{emptyLabel}</p>}
      </div>
    </section>
  )
}

/** The card shell: frame, drag states, arrival. The adapter's button inside
 * carries the interaction and the content. */
export function AgxBoardCard({
  dragging = false,
  compact = false,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  dragging?: boolean
  /** Secondary lines marked `agx-board__card-secondary` fold away. */
  compact?: boolean
}) {
  return (
    <div
      {...props}
      className={className ? `agx-board__card ${className}` : 'agx-board__card'}
      data-compact={compact ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
    >
      {children}
    </div>
  )
}

/** The card's inner padding; the adapter fills it. */
export function AgxBoardCardBody({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={className ? `agx-board__card-body ${className}` : 'agx-board__card-body'}>
      {children}
    </div>
  )
}

/** A row of fact chips. */
export function AgxBoardChips({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={className ? `agx-board__chips ${className}` : 'agx-board__chips'}>
      {children}
    </div>
  )
}

/** One fact chip: icon, label, a tone. */
export function AgxBoardChip({
  tone,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'warn' | 'bad' | 'good'
}) {
  return (
    <span
      {...props}
      className={className ? `agx-board__chip ${className}` : 'agx-board__chip'}
      data-tone={tone}
    >
      {children}
    </span>
  )
}

/** Where a supported move would land inside a column. */
export function AgxBoardDrop() {
  return <span aria-hidden="true" className="agx-board__drop" />
}
