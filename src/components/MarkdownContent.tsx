import { memo, useMemo, type MouseEvent, type ReactNode } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
import { preprocessWikilinks, WIKILINK_SCHEME } from '../utils/chatWikilinks'
import { renderMathToHtml } from '../utils/mathMarkdown'
import { supportsModernRegexFeatures } from '../utils/regexCapabilities'
import { openExternalUrl } from '../utils/url'
import { SafeHtmlSpan } from './SafeMarkup'

const MODERN_REGEX_AVAILABLE = supportsModernRegexFeatures()
const REMARK_PLUGINS = MODERN_REGEX_AVAILABLE ? [remarkGfm] : []
const REHYPE_PLUGINS = MODERN_REGEX_AVAILABLE ? [rehypeHighlight] : []
const MATH_INLINE_SCHEME = 'math-inline:'
const MATH_DISPLAY_SCHEME = 'math-display:'

function chatUrlTransform(url: string): string {
  if (url.startsWith(WIKILINK_SCHEME)
    || url.startsWith(MATH_INLINE_SCHEME)
    || url.startsWith(MATH_DISPLAY_SCHEME)) return url
  return defaultUrlTransform(url)
}

function mathLink(latex: string, displayMode: boolean): string {
  const scheme = displayMode ? MATH_DISPLAY_SCHEME : MATH_INLINE_SCHEME
  return `[math](${scheme}${encodeURIComponent(latex.trim())})`
}

function replaceMathOutsideCodeFences(content: string): string {
  return content
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, latex: string) => `\n\n${mathLink(latex, true)}\n\n`)
        .replace(/\$\$([\s\S]*?)\$\$/g, (_, latex: string) => `\n\n${mathLink(latex, true)}\n\n`)
        .replace(/\\\(([^\n]*?)\\\)/g, (_, latex: string) => mathLink(latex, false))
        .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix: string, latex: string) => (
          `${prefix}${mathLink(latex, false)}`
        ))
    })
    .join('')
}

function mathMarkup(href: string): ReactNode | null {
  const displayMode = href.startsWith(MATH_DISPLAY_SCHEME)
  if (!displayMode && !href.startsWith(MATH_INLINE_SCHEME)) return null
  const scheme = displayMode ? MATH_DISPLAY_SCHEME : MATH_INLINE_SCHEME
  let latex: string
  try {
    latex = decodeURIComponent(href.slice(scheme.length))
  } catch {
    return null
  }
  return (
    <SafeHtmlSpan
      className={displayMode ? 'ai-math-display' : 'ai-math-inline'}
      markup={renderMathToHtml({ latex, displayMode })}
    />
  )
}

function isExplicitWebUrl(href?: string): href is string {
  const lowerHref = href?.trim().toLowerCase() ?? ''
  return lowerHref.startsWith('http://') || lowerHref.startsWith('https://')
}

function openExplicitWebUrl(event: MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault()
  void openExternalUrl(href).catch((error) => {
    console.warn('[ai] Failed to open external link:', error)
  })
}

interface MarkdownContentProps {
  content: string
  onWikilinkClick?: (target: string) => void
}

export const MarkdownContent = memo(function MarkdownContent({ content, onWikilinkClick }: MarkdownContentProps) {
  const processedContent = useMemo(
    () => replaceMathOutsideCodeFences(onWikilinkClick ? preprocessWikilinks(content) : content),
    [content, onWikilinkClick],
  )

  const components = useMemo(() => {
    return {
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const math = href ? mathMarkup(href) : null
        if (math) return math
        if (onWikilinkClick && href?.startsWith(WIKILINK_SCHEME)) {
          const target = decodeURIComponent(href.slice(WIKILINK_SCHEME.length))
          return (
            <a
              ref={(node) => {
                node?.setAttribute('role', 'link')
                node?.setAttribute('tabindex', '0')
              }}
              href={href}
              className="chat-wikilink border-0 bg-transparent p-0"
              data-wikilink-target={target}
              onClick={(event) => {
                event.preventDefault()
                onWikilinkClick(target)
              }}
            >
              {children}
            </a>
          )
        }
        if (isExplicitWebUrl(href)) {
          return <a href={href} onClick={(event) => openExplicitWebUrl(event, href)}>{children}</a>
        }
        return <a href={href}>{children}</a>
      },
    }
  }, [onWikilinkClick])

  return (
    <div className="ai-markdown min-w-0 max-w-full overflow-hidden">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={chatUrlTransform}
      >
        {processedContent}
      </Markdown>
    </div>
  )
})
