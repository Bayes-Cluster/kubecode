import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentUiMatrix } from '@/components/workspace/AgentUiMatrix'
import { translate, type TranslationKey } from '@/lib/i18n'

/**
 * ADR 0257 §7: the agent-ui section of #/controls shows the production
 * primitives with deterministic fixtures — a fixture advances only through a
 * visible control, and every label is localized.
 */
describe('AgentUiMatrix', () => {
  it('renders the production primitives in their states, localized', () => {
    const t = (key: TranslationKey) => translate('en-US', key)
    render(<AgentUiMatrix t={t} />)
    expect(screen.getByText(translate('en-US', 'kubecode.matrix.section.agentui'))).toBeInTheDocument()
    expect(screen.getAllByRole('radiogroup').length).toBeGreaterThanOrEqual(3)
    expect(screen.getByRole('radiogroup', { name: translate('en-US', 'kubecode.matrix.sample.layoutView') })).toBeInTheDocument()
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(translate('en-US', 'kubecode.matrix.sample.thinkingPhase'))
    expect(document.querySelector('.agx-shimmer')).not.toBeNull()
    expect(screen.getByText('128')).toBeInTheDocument()
    expect(screen.getByText(translate('en-US', 'kubecode.matrix.sample.swapSource'))).toBeInTheDocument()
    expect(screen.queryByText(translate('en-US', 'kubecode.matrix.official.sample.thinking'))).not.toBeInTheDocument()
  })

  it('advances the loader and the counter only through the visible controls', () => {
    const t = (key: TranslationKey) => translate('en-US', key)
    render(<AgentUiMatrix t={t} />)
    fireEvent.click(screen.getByRole('button', { name: translate('en-US', 'kubecode.matrix.sample.advance') }))
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(translate('en-US', 'kubecode.matrix.sample.thinkingNext'))
    fireEvent.click(screen.getByRole('button', { name: translate('en-US', 'kubecode.matrix.sample.settle') }))
    expect(
      screen
        .getAllByRole('status')
        .some((region) => region.textContent?.includes(translate('en-US', 'kubecode.matrix.sample.thinkingDone'))),
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: translate('en-US', 'kubecode.matrix.sample.countUp') }))
    expect(screen.getByText('175')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: translate('en-US', 'kubecode.matrix.sample.swap') }))
    expect(screen.getByText(translate('en-US', 'kubecode.matrix.sample.swapped'))).toBeInTheDocument()
  })
})
