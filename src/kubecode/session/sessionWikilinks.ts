/**
 * Wikilinks become same-page fragment links: the hardened streamdown
 * configuration (ADR 0241 §4) drops every protocol but http, https and
 * mailto, while a fragment survives sanitizing and hardening untouched.
 */
const WIKILINK_FRAGMENT = '#kubecode-wikilink='

function encodeTarget(target: string): string {
  return encodeURIComponent(target).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

function linkWikilinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, (_, inner: string) => {
    const pipe = inner.indexOf('|')
    const target = pipe === -1 ? inner : inner.slice(0, pipe)
    const display = pipe === -1 ? inner : inner.slice(pipe + 1)
    return `[${display.replace(/[[\]]/g, '\\$&')}](${WIKILINK_FRAGMENT}${encodeTarget(target)})`
  })
}

/** `[[Target]]` outside fenced code and inline code spans becomes a link. */
export function preprocessSessionWikilinks(markdown: string): string {
  const code = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g
  let out = ''
  let last = 0
  for (const match of markdown.matchAll(code)) {
    out += linkWikilinks(markdown.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return out + linkWikilinks(markdown.slice(last))
}

export function wikilinkTarget(href: string | undefined): string | null {
  if (!href?.startsWith(WIKILINK_FRAGMENT)) return null
  try {
    return decodeURIComponent(href.slice(WIKILINK_FRAGMENT.length))
  } catch {
    return null
  }
}

