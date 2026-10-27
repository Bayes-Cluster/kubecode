import { useId, useRef, useState } from 'react'

import { BlurSwap } from './blur-swap'
import './source-list.css'

/**
 * ADR 0257, adapting the affectUI "Cited Answer" source presentation
 * (https://www.affectui.com/components/cited-answer, Clean preview, captured
 * 2026-10-26): a row of source chips over an expanding preview whose content
 * crossfades between selections. Reproduced: the chip row (kind, number,
 * title), the selected-chip look, the bounded fold disclosure
 * (grid-rows 0fr→1fr), the preview crossfade, the close affordance, pointer/
 * keyboard/touch parity (a chip is a button; Enter and Space select; the
 * fold opens without moving the reading position above it). Deviations: the
 * chips are typed Kubecode references, not web citations — no favicons, no
 * hrefs, no `[n]` inline markers and no sentence highlighting (ADR 0255
 * keeps a wikilink distinct from a citation, and the server provides no
 * source-span bindings); availability states (changed/removed/unavailable)
 * stay visible instead of a confidence score; every label comes from the
 * caller, localized.
 *
 * States: loading/unavailable/changed titles pass through `state`;
 * `#/controls` (AgentUiMatrix) demonstrates selected, changed and
 * unavailable.
 */

export interface SourceItem {
  id: string
  /** What kind of record this is, one or two words. Localized. */
  kindLabel: string
  title: string
  /** The cited revision, e.g. "v3". Optional. */
  versionLabel?: string
  /** An availability state the caller resolved; stays visible. `loading`
   * marks a resolution still in flight. */
  state?: { tone: 'ok' | 'warn' | 'error' | 'loading'; label: string }
  /** A short real excerpt for the preview; the preview shows meta only without one. */
  snippet?: string
}

export interface SourceListProps {
  sources: SourceItem[]
  /** Accessible name of the chips row. Localized. */
  'aria-label': string
  /** Label for the preview's open action. Localized. */
  openLabel: string
  /** Label for the preview's close action. Localized. */
  closeLabel: string
  /** Accessible name of the preview panel. Localized. */
  previewLabel: string
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  onOpen?: (id: string) => void
  className?: string
}

export function SourceList({
  sources,
  'aria-label': ariaLabel,
  openLabel,
  closeLabel,
  previewLabel,
  selectedId,
  onSelect,
  onOpen,
  className,
}: SourceListProps) {
  const previewId = useId()
  const [internal, setInternal] = useState<string | null>(null)
  const selected = (selectedId === undefined ? internal : selectedId) ?? null
  const current = sources.find((source) => source.id === selected) ?? null
  // Chips by id, so closing the preview can hand focus back to the chip that
  // opened it instead of dropping it to the document.
  const chips = useRef(new Map<string, HTMLButtonElement>())

  const select = (id: string) => {
    const next = id === selected ? null : id
    if (selectedId === undefined) setInternal(next)
    onSelect?.(next)
  }

  const closeFromPreview = () => {
    if (!current) return
    chips.current.get(current.id)?.focus()
    select(current.id)
  }

  return (
    <div className={className ? `agx-src ${className}` : 'agx-src'} data-open={current ? '' : undefined}>
      <div className="agx-src__chips" role="list" aria-label={ariaLabel}>
        {sources.map((source, index) => {
          const isSelected = source.id === selected
          return (
            <div key={source.id} role="listitem" className="agx-src__slot">
              <button
                type="button"
                className="agx-src__chip"
                aria-expanded={isSelected}
                aria-controls={isSelected ? previewId : undefined}
                data-selected={isSelected || undefined}
                onClick={() => select(source.id)}
                ref={(element) => {
                  if (element) chips.current.set(source.id, element)
                  else chips.current.delete(source.id)
                }}
              >
                <span className="agx-src__chip-head">
                  <span className="agx-src__kind">{source.kindLabel}</span>
                  <span className="agx-src__num">{index + 1}</span>
                  {source.versionLabel && <span className="agx-src__version">{source.versionLabel}</span>}
                  {source.state && (
                    <span className="agx-src__dot" data-tone={source.state.tone} title={source.state.label}>
                      <span className="agx-src__sr">{source.state.label}</span>
                    </span>
                  )}
                </span>
                <span className="agx-src__title" dir="auto">
                  {source.title}
                </span>
              </button>
            </div>
          )
        })}
      </div>
      <div className="agx-src__fold">
        <div className="agx-src__fold-inner">
          {current && (
            <section className="agx-src__preview" id={previewId} aria-label={previewLabel}>
              <BlurSwap swapKey={current.id}>
                <header className="agx-src__preview-head">
                  <span className="agx-src__preview-kind">{current.kindLabel}</span>
                  <span className="agx-src__preview-title" dir="auto">
                    {current.title}
                  </span>
                  {current.versionLabel && (
                    <span className="agx-src__version">{current.versionLabel}</span>
                  )}
                  {current.state && (
                    <span className="agx-src__state" data-tone={current.state.tone}>
                      {current.state.label}
                    </span>
                  )}
                </header>
                {current.snippet && (
                  <p className="agx-src__snippet" dir="auto">
                    {current.snippet}
                  </p>
                )}
              </BlurSwap>
              <footer className="agx-src__preview-foot">
                {onOpen && (
                  <button type="button" className="agx-src__open" onClick={() => onOpen(current.id)}>
                    {openLabel}
                  </button>
                )}
                <button
                  type="button"
                  className="agx-src__close"
                  aria-label={closeLabel}
                  onClick={closeFromPreview}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </footer>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
