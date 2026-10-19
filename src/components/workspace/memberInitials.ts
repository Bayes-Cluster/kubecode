const SEGMENTER = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

function graphemes(text: string): string[] {
  return SEGMENTER ? Array.from(SEGMENTER.segment(text), (part) => part.segment) : Array.from(text)
}

/** The first letter, digit, or pictograph of a word, as a whole grapheme. */
function leading(word: string): string | null {
  return graphemes(word).find((grapheme) => /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(grapheme)) ?? null
}

/**
 * Up to two initials: the leading letter of the first two words, skipping
 * punctuation. Scripts written without spaces between words (Chinese,
 * Japanese) and single words read better with one character.
 */
export function initialsOf(name: string): string {
  const letters = name.trim().split(/\s+/).map(leading).filter((letter): letter is string => Boolean(letter))
  if (letters.length === 0) return '?'
  const firstTwo = letters.slice(0, 2)
  const alphabetic = firstTwo.every((letter) => /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u.test(letter))
  if (firstTwo.length === 1 || !alphabetic) return firstTwo[0].toLocaleUpperCase()
  return firstTwo.join('').toLocaleUpperCase()
}
