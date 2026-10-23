import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AiAgentIcon } from './AiAgentIcon'

describe('AiAgentIcon', () => {
  it('inverts dark monochrome logos in dark theme so they stay visible (#254)', () => {
    const { container } = render(<AiAgentIcon agent="codex" />)
    expect(container.querySelector('img')).toHaveClass('dark:invert')
  })

  it('leaves coloured logos untouched', () => {
    const { container } = render(<AiAgentIcon agent="claude_code" />)
    expect(container.querySelector('img')).not.toHaveClass('dark:invert')
  })
})
