import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent } from '@/components/ai-elements/reasoning'

// ADR 0241 / ADR 0255: the one hardened streamdown configuration — no raw
// HTML, only safe link protocols — and KaTeX math.
describe('hardened streamdown', () => {
  it('never renders raw HTML from the markdown', () => {
    const { container } = render(
      <MessageResponse>{'Hello <img src=x onerror="alert(1)"> <script>alert(2)</script><b>bold</b>'}</MessageResponse>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    // The markup stays visible as text, never as elements or handlers.
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container.textContent).toContain('<b>bold</b>')
  })

  it('keeps http, https and mailto links and blocks other protocols', () => {
    const { container } = render(
      <MessageResponse>
        {'[web](https://example.com/a) [mail](mailto:a@example.com) [bad](javascript:alert(1)) [data](data:text/html,hi) [file](file:///etc/passwd)'}
      </MessageResponse>,
    )
    const hrefs = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))
    expect(hrefs).toContain('https://example.com/a')
    expect(hrefs).toContain('mailto:a@example.com')
    expect(container.innerHTML).not.toMatch(/javascript:|data:text\/html|file:\/\//)
  })

  it('renders $…$ and $$…$$ math with KaTeX', () => {
    const { container } = render(<MessageResponse>{'Inline $x^2$ and\n\n$$\\int_0^1 x\\,dx$$'}</MessageResponse>)
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2)
  })

  it('caps sizes a message asks for, so math cannot cover the page (ADR 0229 §7)', () => {
    const { container } = render(<MessageResponse>{'$\\rule{500em}{500em}$'}</MessageResponse>)
    const drawn = container.querySelector('.katex-html')
    expect(drawn).not.toBeNull()
    // The source stays in the annotation; what is drawn is capped at maxSize.
    expect(drawn!.innerHTML).not.toContain('500em')
    expect(drawn!.innerHTML).toContain('10em')
  })

  it('stops a macro that expands without end instead of hanging', () => {
    const { container } = render(<MessageResponse>{'$\\def\\a{\\a\\a}\\a$'}</MessageResponse>)
    expect(container.querySelector('.katex-error')).not.toBeNull()
    expect(container.querySelector('.katex-html')).toBeNull()
  })

  it('hardens reasoning content the same way', () => {
    const { container } = render(
      <Reasoning defaultOpen>
        <ReasoningContent>{'<img src=x onerror="alert(1)"> [bad](javascript:alert(1))'}</ReasoningContent>
      </Reasoning>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('javascript:')
  })

  it('adds no unnamed controls to tables and code (their English labels are not localized yet)', () => {
    const { container } = render(<MessageResponse>{'| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint(1)\n```'}</MessageResponse>)
    expect(container.querySelector('table')).not.toBeNull()
    for (const button of container.querySelectorAll('button')) {
      expect(button.getAttribute('aria-label') || button.textContent?.trim()).toBeTruthy()
    }
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})

