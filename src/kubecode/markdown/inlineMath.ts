/**
 * Inline `$…$` is math only under the rules ADR 0229 §7 names (remark-math's
 * documented ones, which micromark does not enforce): the opening `$` is not
 * escaped, doubled or followed by whitespace, the closing one is not preceded
 * by whitespace and not followed by a digit. Every other single `$` in prose
 * is escaped, so prices ("$5 and $10") and shell variables ("echo $USER")
 * stay text. Nothing is touched inside fenced code, inline code spans or
 * `$$…$$` display math. Applied by every Kubecode adapter before streamdown.
 */

const INLINE_DOLLAR_MATH = /(^|[^\\$])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?![$\d])/g

/** A code span: a run of backticks, then anything up to the same run. */
const CODE_SPAN = /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g

/** Every unescaped single `$` in text that is not math. */
function escapeDollars(text: string): string {
  return text.replace(/\$/g, (dollar, index: number) => (text[index - 1] === '\\' ? dollar : '\\$'))
}

/** Keeps the `$…$` pairs that qualify and escapes the rest. */
function strictInlineMath(prose: string): string {
  let out = ''
  let last = 0
  for (const match of prose.matchAll(INLINE_DOLLAR_MATH)) {
    const start = match.index + match[1].length
    out += escapeDollars(prose.slice(last, start)) + `$${match[2]}$`
    last = match.index + match[0].length
  }
  return out + escapeDollars(prose.slice(last))
}

/** Prose between display-math blocks, which are kept whole. */
function outsideDisplayMath(text: string): string {
  return text
    .split(/(\$\$[\s\S]*?\$\$)/g)
    .map((part, index) => (index % 2 === 1 ? part : strictInlineMath(part)))
    .join('')
}

/** Prose between code, which is kept whole. */
export function prepareInlineMath(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
    .map((part, index) => {
      if (index % 2 === 1) return part
      let out = ''
      let last = 0
      for (const match of part.matchAll(CODE_SPAN)) {
        out += outsideDisplayMath(part.slice(last, match.index)) + match[0]
        last = match.index + match[0].length
      }
      return out + outsideDisplayMath(part.slice(last))
    })
    .join('')
}
