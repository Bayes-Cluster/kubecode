import { memo, useMemo, type MouseEvent, type ReactNode } from 'react'

import { MessageResponse } from '@/components/ai-elements/message'
import { openExternalUrl } from '@/utils/url'

import { prepareInlineMath } from '../markdown/inlineMath'
import { PROSE_ROOT, Strong, WikilinkAnchor } from '../markdown/MarkdownParts'
import { preprocessSessionWikilinks, wikilinkTarget } from './sessionWikilinks'

function isWebUrl(href: string | undefined): href is string {
  const lower = href?.trim().toLowerCase() ?? ''
  return lower.startsWith('http://') || lower.startsWith('https://')
}

/**
 * Session markdown on the official `MessageResponse` (ADR 0245): hardened
 * streamdown with highlighted code and KaTeX, plus Kubecode's wikilinks
 * (streamdown's link, navigation intercepted, #278) and external-link opening.
 */
export const SessionMarkdown = memo(function SessionMarkdown({
  content,
  'data-testid': testId,
  isAnimating = false,
  onWikilinkClick,
}: {
  content: string
  'data-testid'?: string
  isAnimating?: boolean
  onWikilinkClick?: (target: string) => void
}) {
  const source = useMemo(
    () => prepareInlineMath(onWikilinkClick ? preprocessSessionWikilinks(content) : content),
    [content, onWikilinkClick],
  )
  const components = useMemo(() => ({
    strong: Strong,
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const target = onWikilinkClick ? wikilinkTarget(href) : null
      if (target !== null && onWikilinkClick && href) {
        return <WikilinkAnchor href={href} target={target} onNavigate={onWikilinkClick}>{children}</WikilinkAnchor>
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
    <MessageResponse {...PROSE_ROOT} components={components} data-testid={testId} isAnimating={isAnimating}>
      {source}
    </MessageResponse>
  )
})
