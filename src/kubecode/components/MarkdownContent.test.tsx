import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownContent } from '@/components/MarkdownContent'
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
