import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CodeEditor } from './CodeEditor'

describe('CodeEditor', () => {
  it('preserves the editor, scroll position, and DOM selection across controlled rerenders', () => {
    const content = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n')
    const firstChange = vi.fn()
    const { container, rerender } = render(
      <CodeEditor content={content} documentKey="project-1:main.ts" onChange={firstChange} />,
    )
    const editor = container.querySelector('.cm-editor')
    const scroller = container.querySelector('.cm-scroller') as HTMLElement
    const text = container.querySelector('.cm-line')?.firstChild
    expect(editor).not.toBeNull()
    expect(text).not.toBeNull()
    scroller.scrollTop = 240
    const selection = window.getSelection()
    const range = document.createRange()
    range.setStart(text as Node, 2)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)

    rerender(
      <CodeEditor content={content} documentKey="project-1:main.ts" onChange={vi.fn()} />,
    )

    expect(container.querySelector('.cm-editor')).toBe(editor)
    expect(container.querySelector('.cm-scroller')).toBe(scroller)
    expect(scroller.scrollTop).toBe(240)
    expect(container.querySelector('.cm-content')).toContainElement(selection?.anchorNode?.parentElement ?? null)
  })

  it('synchronizes externally replaced content without remounting the editor', () => {
    const { container, rerender } = render(
      <CodeEditor content="before" documentKey="project-1:main.ts" onChange={vi.fn()} />,
    )
    const editor = container.querySelector('.cm-editor')

    rerender(
      <CodeEditor content="after" documentKey="project-1:main.ts" onChange={vi.fn()} />,
    )

    expect(container.querySelector('.cm-editor')).toBe(editor)
    expect(container.querySelector('.cm-content')).toHaveTextContent('after')
  })
})
