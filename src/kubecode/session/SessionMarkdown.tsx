import { memo, useMemo, type MouseEvent, type ReactNode } from 'react'

import { MessageResponse } from '@/components/ai-elements/message'
import { openExternalUrl } from '@/utils/url'

import { preprocessSessionWikilinks, wikilinkTarget } from './sessionWikilinks'

function isWebUrl(href: string | undefined): href is string {
  const lower = href?.trim().toLowerCase() ?? ''
  return lower.startsWith('http://') || lower.startsWith('https://')
}

/**
 * Session markdown on the official `MessageResponse` (ADR 0245): hardened
 * streamdown with highlighted code and KaTeX, plus Kubecode's wikilinks and
 * external-link opening.
 */
export const SessionMarkdown = memo(function SessionMarkdown({
  content,
  isAnimating = false,
  onWikilinkClick,
}: {
  content: string
  isAnimating?: boolean
  onWikilinkClick?: (target: string) => void
}) {
  const source = useMemo(
    () => (onWikilinkClick ? preprocessSessionWikilinks(content) : content),
    [content, onWikilinkClick],
  )
  const components = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const target = onWikilinkClick ? wikilinkTarget(href) : null
      if (target !== null && onWikilinkClick) {
        return (
          <a
            className="chat-wikilink"
            data-wikilink-target={target}
            href={href}
            onClick={(event) => {
              event.preventDefault()
              onWikilinkClick(target)
            }}
          >
            {children}
          </a>
        )
      }
      if (isWebUrl(href)) {
        return (
          <a
            href={href}
            rel="noreferrer"
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault()
              void openExternalUrl(href).catch((error) => {
                console.warn('[session] Failed to open external link:', error)
              })
            }}
          >
            {children}
          </a>
        )
      }
      return <a href={href}>{children}</a>
    },
  }), [onWikilinkClick])

  return (
    <MessageResponse
      className="kubecode-session-markdown"
      components={components}
      isAnimating={isAnimating}
    >
      {source}
    </MessageResponse>
  )
})
