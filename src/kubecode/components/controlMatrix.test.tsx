import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ControlMatrix } from '@/components/workspace/ControlMatrix'
import { controlMatrixRequest, longestTranslation } from '@/components/workspace/controlMatrixRoute'
import { APP_LOCALES, createTranslator, translate } from '@/lib/i18n'

describe('control matrix (ADR 0227)', () => {
  it('opens only on its own address, with a theme and a shipped locale', () => {
    expect(controlMatrixRequest('#/p/x/general')).toBeNull()
    expect(controlMatrixRequest('#/controlsx')).toBeNull()
    expect(controlMatrixRequest('#/controls')).toEqual({ theme: 'light', locale: 'en' })
    expect(controlMatrixRequest('#/controls?theme=dark&lang=de-DE')).toEqual({ theme: 'dark', locale: 'de-DE' })
    expect(controlMatrixRequest('#/controls?theme=sepia&lang=xx')).toEqual({ theme: 'light', locale: 'en' })
  })

  it('finds the longest translation of a label across the locales', () => {
    const longest = longestTranslation('kubecode.task.acceptResults')
    expect(translate(longest.locale, 'kubecode.task.acceptResults')).toBe(longest.text)
    for (const locale of APP_LOCALES) {
      expect(translate(locale, 'kubecode.task.acceptResults').length).toBeLessThanOrEqual(longest.text.length)
    }
  })

  it('names every control it shows', () => {
    render(<ControlMatrix t={createTranslator('en')} />)
    expect(screen.getByTestId('control-matrix')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace controls' })).toBeInTheDocument()
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName()
    }
    for (const box of screen.getAllByRole('textbox')) {
      expect(box).toHaveAccessibleName()
    }
    // Long samples are marked with their language.
    expect(document.querySelectorAll('.kubecode-control-matrix-narrow [lang]').length).toBeGreaterThan(0)
    // Stopping a run and pausing routing are different, named controls.
    expect(screen.getAllByRole('button', { name: "Stop Analyst's run" }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Pause new work on this Task' }).length).toBeGreaterThan(0)
  })

  it('shows the production composer, not a demo-only Prompt Input (ADR 0247)', () => {
    render(<ControlMatrix t={createTranslator('en')} />)
    const official = screen.getByTestId('official-components')
    const composers = official.querySelectorAll('.kubecode-composer')
    expect(composers).toHaveLength(2)
    for (const composer of composers) expect(composer.querySelector('[data-slot="input-group"], form')).not.toBeNull()
    expect(document.querySelector('.kubecode-composer-to')).toBeNull()
  })

  it('shows the official components themed through the Workspace tokens, labelled from the catalog (ADR 0241)', () => {
    render(<ControlMatrix t={createTranslator('de-DE')} />)
    const official = screen.getByTestId('official-components')
    expect(official).not.toHaveAttribute('data-ws-components')
    expect(official.querySelectorAll('[data-slot="card"], [data-slot="item"], [data-slot="empty"], [data-slot="alert"]').length).toBeGreaterThan(3)
    expect(screen.getByRole('heading', { name: 'Offizielle Komponenten' })).toBeInTheDocument()
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName()
    }
    for (const english of ['Submit', 'Stop', 'Parameters', 'Result', 'Toggle plan', 'Thinking...', 'What would you like to know?', 'Loading', 'Upload files']) {
      expect(official.textContent).not.toContain(english)
      expect(official.querySelector(`[aria-label="${english}"], [placeholder="${english}"]`)).toBeNull()
    }
  })
})
