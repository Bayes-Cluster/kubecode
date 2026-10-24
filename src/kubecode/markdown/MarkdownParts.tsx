import type { MouseEvent, ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'

/**
 * The parts Kubecode hands to the official `MessageResponse` on every
 * Markdown surface (#278): one Badge for an image that is never fetched, one
 * Badge for a wikilink, and `strong` kept as `strong`. The hardening itself
 * stays in `streamdown-hardening.ts`.
 */

/** An image in a message is its description: nothing is fetched from where an agent points. */
export function InertImage({ alt }: { alt?: unknown; node?: unknown }) {
  return <Badge data-testid="inert-image" variant="outline">{typeof alt === 'string' ? alt : ''}</Badge>
}

/** Emphasis stays `strong` for assistive technology; streamdown draws it as a styled `span`. */
export function Strong({ children }: { children?: ReactNode; node?: unknown }) {
  return <strong className="font-semibold" data-streamdown="strong">{children}</strong>
}

/**
 * A wikilink to a Workspace record: the official Badge around a real anchor,
 * so it is reached by Tab and followed by Enter like any link. (AI Elements
 * `InlineCitation` is a hover card over cited web sources and needs the
 * server to mark cited spans, ADR 0236; a wikilink is navigation.)
 */
export function WikilinkBadge({ children, href, onNavigate, target }: {
  children?: ReactNode
  href: string
  onNavigate: (target: string) => void
  target: string
}) {
  return (
    <Badge asChild variant="secondary">
      <a
        data-wikilink-target={target}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault()
          onNavigate(target)
        }}
      >
        {children}
      </a>
    </Badge>
  )
}
