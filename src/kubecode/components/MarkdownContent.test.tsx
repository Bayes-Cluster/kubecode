import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownContent } from '@/components/MarkdownContent'
import { renderMathToHtml } from '@/utils/mathMarkdown'
import { splitMarkdownBlocks } from '../../utils/markdownBlocks'

describe('splitMarkdownBlocks', () => {
  it('splits on paragraph boundaries', () => {
    expect(splitMarkdownBlocks('Para one.\n\nPara two.')).toEqual(['Para one.', 'Para two.'])
  })

  it('does not split inside code fences', () => {
    const content = 'Before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter'
    const blocks = splitMarkdownBlocks(content)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toContain('const a = 1;')
    expect(blocks[1]).toContain('const b = 2;')
  })

  it('does not split inside tilde fences', () => {
    const content = 'Before\n\n~~~\nsome\ntext\n~~~\n\nAfter'
    const blocks = splitMarkdownBlocks(content)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toContain('some\ntext')
  })

  it('returns empty for empty content', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
  })

  it('returns a single block for content without paragraph breaks', () => {
    expect(splitMarkdownBlocks('Just one line')).toEqual(['Just one line'])
  })

  it('handles unclosed fences at the tail (streaming)', () => {
    const content = 'Text\n\n```js\nconst x = 1;'
    const blocks = splitMarkdownBlocks(content)
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toContain('const x = 1;')
  })
})

describe('MarkdownContent block-level rendering (#112)', () => {
  it('renders markdown content into the DOM', () => {
    const content = '# Title\n\nPara 1.'
    render(<MarkdownContent content={content} />)
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Para 1.')).toBeInTheDocument()
  })

  it('renders long streaming content within bounded cost per delta', () => {
    // Build a long document: 50 paragraphs + code fences.
    let content = ''
    for (let index = 0; index < 50; index += 1) {
      content += `Paragraph ${index} with some text.\n\n`
      if (index % 10 === 0) content += '```\ncode block ${index}\n```\n\n'
    }

    // Block splitting must be fast (the only per-delta work on stable blocks
    // is re-splitting, which is O(lines); the expensive markdown parse is
    // memoized per block by React).
    const start = performance.now()
    const blocks = splitMarkdownBlocks(content)
    const elapsed = performance.now() - start
    expect(blocks.length).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(50)
  })

  it('only the tail block content changes when a delta appends text', () => {
    const before = splitMarkdownBlocks('Para 1.\n\nPara 2.\n\nPara')
    const after = splitMarkdownBlocks('Para 1.\n\nPara 2.\n\nPara 3 added')
    // Stable blocks keep the same content.
    expect(before[0]).toBe(after[0])
    expect(before[1]).toBe(after[1])
    // Only the tail block differs.
    expect(before[2]).not.toBe(after[2])
    expect(after[2]).toContain('Para 3 added')
  })
})

describe('MarkdownContent images (ADR 0229 §7)', () => {
  it('shows an image as its alternative text when asked, so a message makes no request', () => {
    const { container } = render(<MarkdownContent content={'Look: ![loss curve](https://example.test/x.png)'} images="text" />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('loss curve')).toHaveClass('kubecode-inert-image')
  })

  it('still renders images by default', () => {
    const { container } = render(<MarkdownContent content={'![loss curve](https://example.test/x.png)'} />)
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('keeps raw HTML and javascript: links inert', () => {
    const { container } = render(
      <MarkdownContent content={'<script>alert(1)</script>\n\n**bold** [go](javascript:alert(1))'} images="text" />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('go').getAttribute('href') ?? '').not.toContain('javascript')
  })
})

describe('MarkdownContent math (ADR 0229 §7)', () => {
  it('keeps prices and shell variables literal', () => {
    const { container } = render(<MarkdownContent content={'It costs $5 and $10 a run. Set `$PATH` and `$HOME`, then echo $USER.'} images="text" />)
    expect(container.querySelector('.ai-math-inline, .katex')).toBeNull()
    expect(container).toHaveTextContent('It costs $5 and $10 a run. Set $PATH and $HOME, then echo $USER.')
    expect(screen.getByText('$PATH').tagName).toBe('CODE')
  })

  it('keeps dollars literal inside inline code, even two of them', () => {
    const { container } = render(<MarkdownContent content={'Run `echo $A $B` and ``a `$x$` b`` here.'} images="text" />)
    expect(container.querySelector('.ai-math-inline, .katex')).toBeNull()
    expect(screen.getByText('echo $A $B').tagName).toBe('CODE')
    expect(screen.getByText('a `$x$` b').tagName).toBe('CODE')
  })

  it('does not take a closing dollar followed by a digit or spaces inside the delimiters as math', () => {
    const { container } = render(<MarkdownContent content={'Between $ 5 $ and $x$2 nothing is math.'} images="text" />)
    expect(container.querySelector('.ai-math-inline')).toBeNull()
  })

  it('still renders inline and display math', () => {
    const { container } = render(<MarkdownContent content={'Accuracy $a_1 + b$ holds.\n\n$$\\sum_i x_i$$\n\nAnd \\(y\\) too.'} images="text" />)
    expect(container.querySelectorAll('.ai-math-inline .katex')).toHaveLength(2)
    expect(container.querySelectorAll('.ai-math-display .katex-display')).toHaveLength(1)
  })
})

describe('renderMathToHtml bounds', () => {
  it('caps sizes a message asks for, so math cannot cover the page', () => {
    const html = renderMathToHtml({ latex: '\\rule{500em}{500em}', displayMode: true })
    // The source stays in the annotation; what is drawn is capped.
    const drawn = html.slice(html.indexOf('katex-html'))
    expect(drawn).not.toContain('500em')
    expect(drawn).toContain('border-right-width:10em;border-top-width:10em')
  })

  it('stops a macro that expands without end', () => {
    const html = renderMathToHtml({ latex: '\\def\\a{\\a\\a}\\a', displayMode: false })
    expect(html).toContain('katex-error')
  })
})
