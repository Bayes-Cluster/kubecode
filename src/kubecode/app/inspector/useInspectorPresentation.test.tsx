import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { INSPECTOR_MIN, useInspectorPresentation, VIEW_MIN } from './useInspectorPresentation'

type Callback = (entries: Array<{ contentRect: { width: number } }>) => void

const observers: Array<{ callback: Callback; disconnected: boolean }> = []

class FakeResizeObserver {
  private record: { callback: Callback; disconnected: boolean }
  constructor(callback: Callback) {
    this.record = { callback, disconnected: false }
    observers.push(this.record)
  }
  observe() {}
  unobserve() {}
  disconnect() { this.record.disconnected = true }
}

function resizeTo(width: number) {
  act(() => {
    for (const observer of observers) {
      if (!observer.disconnected) observer.callback([{ contentRect: { width } }])
    }
  })
}

function Row({ narrowLayout = false, reservedWidth = 0 }: { narrowLayout?: boolean; reservedWidth?: number }) {
  const row = useRef<HTMLDivElement>(null)
  const presentation = useInspectorPresentation(row, { narrowLayout, reservedWidth })
  return <div data-testid="row" data-presentation={presentation} ref={row} />
}

afterEach(() => {
  observers.length = 0
  vi.unstubAllGlobals()
})

describe('useInspectorPresentation', () => {
  it('puts the inspector beside the view only when both fit, after the open tools column', () => {
    expect(VIEW_MIN + INSPECTOR_MIN).toBe(880)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const view = render(<Row />)
    resizeTo(879)
    expect(screen.getByTestId('row')).toHaveAttribute('data-presentation', 'screen')
    resizeTo(880)
    expect(screen.getByTestId('row')).toHaveAttribute('data-presentation', 'side')
    resizeTo(1300)
    expect(screen.getByTestId('row')).toHaveAttribute('data-presentation', 'side')
    view.rerender(<Row reservedWidth={440} />)
    expect(screen.getByTestId('row')).toHaveAttribute('data-presentation', 'screen')
  })

  it('stops observing when it unmounts', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const view = render(<Row />)
    view.unmount()
    expect(observers.every((observer) => observer.disconnected)).toBe(true)
  })

  it('falls back to the narrow layout where nothing can measure the row', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const view = render(<Row narrowLayout />)
    expect(screen.getByTestId('row')).toHaveAttribute('data-presentation', 'screen')
    view.rerender(<Row />)
    expect(screen.getByTestId('row')).toHaveAttribute('data-presentation', 'side')
  })
})
