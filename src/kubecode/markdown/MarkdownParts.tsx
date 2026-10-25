import type { MouseEvent, ReactNode } from 'react'
import { defaultComponents } from 'streamdown'

import { Badge } from '@/components/ui/badge'

/**
 * The parts Kubecode hands to the official `MessageResponse` on every
 * Markdown surface (#278): one Badge for an image that is never fetched,
 * streamdown's own link for a wikilink, and `strong` kept as `strong`. The
 * hardening itself stays in `streamdown-hardening.ts`.
 */

/** The attribute every adapter puts on the streamdown root; the selection allowlist keys on it (ADR 0255 §3). */
export const PROSE_ROOT = { 'data-prose': '' } as const

/** An image in a message is its description: nothing is fetched from where an agent points. */
export function InertImage({ alt }: { alt?: unknown; node?: unknown }) {
  return <Badge data-testid="inert-image" variant="outline">{typeof alt === 'string' ? alt : ''}</Badge>
}

/** Emphasis stays `strong` for assistive technology; streamdown draws it as a styled `span`. */
export function Strong({ children }: { children?: ReactNode; node?: unknown }) {
  return <strong className="font-semibold" data-streamdown="strong">{children}</strong>
}

const StreamdownLink = defaultComponents.a

/**
 * A wikilink to a Workspace record: streamdown's own link, so it owns the
 * look and wraps a long title; only the navigation is Kubecode's. (AI
 * Elements `InlineCitation` is a hover card over cited web sources and needs
 * the server to mark cited spans, ADR 0236; a wikilink is navigation.)
 */
export function WikilinkAnchor({ children, href, onNavigate, target }: {
  children?: ReactNode
  href: string
  onNavigate: (target: string) => void
  target: string
}) {
  const navigate = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    onNavigate(target)
  }
  return (
    <StreamdownLink data-wikilink-target={target} href={href} onClick={navigate}>
      {children}
    </StreamdownLink>
  )
}
