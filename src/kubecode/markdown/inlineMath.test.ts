import { describe, expect, it } from 'vitest'

import { prepareInlineMath } from './inlineMath'

// ADR 0229 §7: inline math only under remark-math's rules; prices and shell variables stay text.
describe('prepareInlineMath', () => {
  it('keeps prices and shell variables literal', () => {
    expect(prepareInlineMath('It costs $5 and $10 a run, then echo $USER.'))
      .toBe('It costs \\$5 and \\$10 a run, then echo \\$USER.')
  })

  it('does not take a closing dollar followed by a digit, or spaces inside the delimiters, as math', () => {
    expect(prepareInlineMath('Between $ 5 $ and $x$2 nothing is math.'))
      .toBe('Between \\$ 5 \\$ and \\$x\\$2 nothing is math.')
  })

  it('keeps qualifying inline math, display math and already escaped dollars', () => {
    expect(prepareInlineMath('Accuracy $a_1 + b$ holds and \\$3 is cash.\n\n$$\\sum_i x_i$$'))
      .toBe('Accuracy $a_1 + b$ holds and \\$3 is cash.\n\n$$\\sum_i x_i$$')
  })

  it('never touches code: fences, open fences and inline spans, even doubled ones', () => {
    const fence = 'Text $5\n\n```sh\necho $A $B\n```\n\nand ``a `$x$` b`` and `$PATH`.\n\n```py\nx = "$9"'
    expect(prepareInlineMath(fence))
      .toBe('Text \\$5\n\n```sh\necho $A $B\n```\n\nand ``a `$x$` b`` and `$PATH`.\n\n```py\nx = "$9"')
  })
})
