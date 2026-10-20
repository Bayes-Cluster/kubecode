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
import { splitMarkdownBlocks } from '../utils/markdownBlocks'

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

/**
 * Inline `$…$` follows remark-math: the opening `$` is not escaped, doubled,
 * or followed by whitespace, the closing one is not preceded by whitespace
 * and not followed by a digit. So "$5 and $10" and shell variables stay text.
 */
const INLINE_DOLLAR_MATH = /(^|[^\\$])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?![$\d])/g

function replaceMathInText(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, latex: string) => `\n\n${mathLink(latex, true)}\n\n`)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, latex: string) => `\n\n${mathLink(latex, true)}\n\n`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_, latex: string) => mathLink(latex, false))
    .replace(INLINE_DOLLAR_MATH, (_, prefix: string, latex: string) => `${prefix}${mathLink(latex, false)}`)
}

/** A code span: a run of backticks, then anything up to the same run. */
const CODE_SPAN = /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g

/** Math is read only in prose: never in fenced code or inline code spans. */
function replaceMathOutsideCode(content: string): string {
  return content
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part
      let out = ''
      let last = 0
      for (const match of part.matchAll(CODE_SPAN)) {
        out += replaceMathInText(part.slice(last, match.index)) + match[0]
        last = match.index + match[0].length
      }
      return out + replaceMathInText(part.slice(last))
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

/** `text` shows an image as its alternative text, so rendering it never fetches anything. */
export type MarkdownImages = 'render' | 'text'

interface MarkdownContentProps {
  content: string
  onWikilinkClick?: (target: string) => void
  images?: MarkdownImages
}

/** Renders a single markdown block — no outer wrapper. */
const MarkdownBlock = memo(function MarkdownBlock({ content, images, onWikilinkClick }: {
  content: string
  onWikilinkClick?: (target: string) => void
  images: MarkdownImages
}) {
  const processedContent = useMemo(
    () => replaceMathOutsideCode(onWikilinkClick ? preprocessWikilinks(content) : content),
    [content, onWikilinkClick],
  )
  const components = useMarkdownComponents(onWikilinkClick, images)
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
      urlTransform={chatUrlTransform}
    >
      {processedContent}
    </Markdown>
  )
})

function inertImage({ alt }: { alt?: string }) {
  return <span className="kubecode-inert-image">{alt ?? ''}</span>
}

function useMarkdownComponents(onWikilinkClick: ((target: string) => void) | undefined, images: MarkdownImages) {
  return useMemo(() => {
    return {
      ...(images === 'text' ? { img: inertImage } : {}),
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
  }, [images, onWikilinkClick])
}

/**
 * Block-level streaming markdown (#112): the content is split into stable
 * blocks by paragraph/code-fence structure; each block is independently
 * memoized so only the tail block re-renders per streaming delta. Completed
 * messages get the same sanitization, shiki, and mermaid treatment as
 * before — just block-by-block instead of full-document.
 */
export const MarkdownContent = memo(function MarkdownContent({ content, images = 'render', onWikilinkClick }: MarkdownContentProps) {
  const blocks = useMemo(
    () => splitMarkdownBlocks(replaceMathOutsideCode(onWikilinkClick ? preprocessWikilinks(content) : content)),
    [content, onWikilinkClick],
  )

  return (
    <div className="ai-markdown min-w-0 max-w-full overflow-hidden">
      {blocks.map((block, index) => (
        <MarkdownBlock
          content={block}
          images={images}
          key={index}
          onWikilinkClick={onWikilinkClick}
        />
      ))}
    </div>
  )
})
