import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPlaceMemory, placeKey, usePlaceMemory, usePlaceRef, usePlaceState, useScrollMemory, type PlaceMemory } from './placeMemory'
import { PlaceMemoryProvider } from './PlaceMemoryProvider'

function Draft({ label, memoryKey }: { label: string; memoryKey: string | null }) {
  const [value, setValue] = usePlaceState(memoryKey, '')
  return <input aria-label={label} value={value} onChange={(event) => setValue(event.target.value)} />
}

function Counter({ memoryKey }: { memoryKey: string }) {
  const [count, setCount] = usePlaceState(memoryKey, 0)
  return (
    <button type="button" onClick={() => { setCount((n) => n + 1); setCount((n) => n + 1) }}>
      {`count ${count}`}
    </button>
  )
}

function within(memory: PlaceMemory, children: ReactNode) {
  return <PlaceMemoryProvider memory={memory}>{children}</PlaceMemoryProvider>
}

describe('placeKey', () => {
  it('keeps General, a Task-scoped General, a Thread, a private conversation, and a view apart', () => {
    const keys = [
      placeKey.general('p1'),
      placeKey.general('p1', 'r1'),
      placeKey.general('p1', null),
      placeKey.thread('p1', 't1'),
      placeKey.dm('p1', 'm1'),
      placeKey.view('p1', 'board'),
      placeKey.task('p1', 'r1'),
      placeKey.general('p2'),
    ]
    expect(keys).toEqual([
      'p1|general', 'p1|general:task:r1', 'p1|general', 'p1|thread:t1', 'p1|dm:m1', 'p1|view:board', 'p1|task:r1',
      'p2|general',
    ])
  })
})

describe('usePlaceState', () => {
  it('keeps what was typed when the view is left and comes back under one provider', () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <Draft label="draft" memoryKey="p1|general#body" />))
    fireEvent.change(screen.getByRole('textbox', { name: 'draft' }), { target: { value: 'half a thought' } })
    view.rerender(within(memory, <p>elsewhere</p>))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    view.rerender(within(memory, <Draft label="draft" memoryKey="p1|general#body" />))
    expect(screen.getByRole('textbox', { name: 'draft' })).toHaveValue('half a thought')
  })

  it('never shows one place’s draft in another', () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <Draft label="draft" memoryKey={placeKey.general('p1')} />))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'for everyone' } })
    view.rerender(within(memory, <Draft label="draft" memoryKey={placeKey.dm('p1', 'm1')} />))
    expect(screen.getByRole('textbox')).toHaveValue('')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private' } })
    view.rerender(within(memory, <Draft label="draft" memoryKey={placeKey.general('p1', 'r1')} />))
    expect(screen.getByRole('textbox')).toHaveValue('')
    view.rerender(within(memory, <Draft label="draft" memoryKey={placeKey.thread('p1', 't1')} />))
    expect(screen.getByRole('textbox')).toHaveValue('')
    view.rerender(within(memory, <Draft label="draft" memoryKey={placeKey.general('p1')} />))
    expect(screen.getByRole('textbox')).toHaveValue('for everyone')
    view.rerender(within(memory, <Draft label="draft" memoryKey={placeKey.dm('p1', 'm1')} />))
    expect(screen.getByRole('textbox')).toHaveValue('private')
  })

  it('applies updates in order, from the latest value', () => {
    render(within(createPlaceMemory(), <Counter memoryKey="p1|count" />))
    fireEvent.click(screen.getByRole('button', { name: 'count 0' }))
    expect(screen.getByRole('button', { name: 'count 2' })).toBeInTheDocument()
  })

  it('is plain component state with no key or no provider', () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <Draft label="draft" memoryKey={null} />))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gone on unmount' } })
    expect(screen.getByRole('textbox')).toHaveValue('gone on unmount')
    view.rerender(within(memory, <p>elsewhere</p>))
    view.rerender(within(memory, <Draft label="draft" memoryKey={null} />))
    expect(screen.getByRole('textbox')).toHaveValue('')

    view.rerender(<Draft label="bare" memoryKey="p1|general#body" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'bare' }), { target: { value: 'local' } })
    expect(screen.getByRole('textbox', { name: 'bare' })).toHaveValue('local')
    view.rerender(<p>elsewhere</p>)
    view.rerender(<Draft label="bare" memoryKey="p1|general#body" />)
    expect(screen.getByRole('textbox', { name: 'bare' })).toHaveValue('')
  })

  it('forgets a Workspace, or every Workspace that is no longer registered', () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, (
      <>
        <Draft label="one" memoryKey={placeKey.general('p1')} />
        <Draft label="two" memoryKey={placeKey.general('p2')} />
        <Draft label="three" memoryKey={placeKey.dm('p3', 'm1')} />
      </>
    )))
    fireEvent.change(screen.getByRole('textbox', { name: 'one' }), { target: { value: 'a' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'two' }), { target: { value: 'b' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'three' }), { target: { value: 'c' } })
    act(() => memory.forgetWorkspace('p1'))
    expect(screen.getByRole('textbox', { name: 'one' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'two' })).toHaveValue('b')
    act(() => memory.prune(['p1', 'p2']))
    expect(screen.getByRole('textbox', { name: 'two' })).toHaveValue('b')
    expect(screen.getByRole('textbox', { name: 'three' })).toHaveValue('')
    act(() => memory.clear(placeKey.general('p2')))
    expect(screen.getByRole('textbox', { name: 'two' })).toHaveValue('')
    view.unmount()
  })

  it('offers the memory to the components under the provider', () => {
    const memory = createPlaceMemory()
    const seen: (PlaceMemory | null)[] = []
    function Probe({ onSeen }: { onSeen: (value: PlaceMemory | null) => void }) {
      onSeen(usePlaceMemory())
      return null
    }
    render(within(memory, <Probe onSeen={(value) => seen.push(value)} />))
    expect(seen.at(-1)).toBe(memory)
  })
})

describe('usePlaceRef', () => {
  function Attempt({ memoryKey, onSeen }: { memoryKey: string | null; onSeen: (value: string | null) => void }) {
    const attemptRef = usePlaceRef<string | null>(memoryKey, null)
    return (
      <>
        <button type="button" onClick={() => { attemptRef.current = 'id-1' }}>attempt</button>
        <button type="button" onClick={() => onSeen(attemptRef.current)}>read</button>
      </>
    )
  }

  it('keeps a value that is not drawn across a remount, and is a plain ref without a key', () => {
    const memory = createPlaceMemory()
    const seen: (string | null)[] = []
    const view = render(within(memory, <Attempt memoryKey="p1|general#attempt" onSeen={(value) => seen.push(value)} />))
    fireEvent.click(screen.getByRole('button', { name: 'attempt' }))
    view.rerender(within(memory, <p>elsewhere</p>))
    view.rerender(within(memory, <Attempt memoryKey="p1|general#attempt" onSeen={(value) => seen.push(value)} />))
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    expect(seen.at(-1)).toBe('id-1')

    view.rerender(within(memory, <Attempt memoryKey={null} onSeen={(value) => seen.push(value)} />))
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    expect(seen.at(-1)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'attempt' }))
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    expect(seen.at(-1)).toBe('id-1')
    view.rerender(within(memory, <p>elsewhere</p>))
    view.rerender(within(memory, <Attempt memoryKey={null} onSeen={(value) => seen.push(value)} />))
    fireEvent.click(screen.getByRole('button', { name: 'read' }))
    expect(seen.at(-1)).toBeNull()
  })
})

describe('useScrollMemory', () => {
  afterEach(() => vi.restoreAllMocks())

  /** A scroller whose geometry the test sets, since jsdom lays nothing out. */
  function List({ memoryKey, ready = true, rows = 10 }: { memoryKey: string; ready?: boolean; rows?: number }) {
    const ref = useRef<HTMLDivElement>(null)
    useScrollMemory(ref, memoryKey, { ready })
    return (
      <div data-testid="scroller" ref={ref}>
        {Array.from({ length: rows }, (_, index) => (
          <p data-scroll-anchor={`row:${index}`} key={index}>{`row ${index}`}</p>
        ))}
      </div>
    )
  }

  const ROW = 40

  /** Rows of 40px in a 100px window over `rows * 40px` of content. */
  function geometry(element: HTMLElement, rows: number) {
    let top = 0
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(value, rows * ROW - 100)) },
    })
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => rows * ROW })
    Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 100 })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const anchor = this.getAttribute('data-scroll-anchor')
      const y = anchor ? Number(anchor.split(':')[1]) * ROW - top : 0
      return { top: y, bottom: y + (anchor ? ROW : 100), left: 0, right: 0, height: anchor ? ROW : 100, width: 0, x: 0, y } as DOMRect
    })
  }

  async function frame() {
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
  }

  it('returns to the row that was at the top, at the same offset', async () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <List memoryKey="p1|view:board" />))
    let scroller = screen.getByTestId('scroller')
    geometry(scroller, 10)
    scroller.scrollTop = 130
    fireEvent.scroll(scroller)
    await frame()
    view.rerender(within(memory, <p>elsewhere</p>))

    view.rerender(within(memory, <List memoryKey="p1|view:board" ready={false} />))
    scroller = screen.getByTestId('scroller')
    geometry(scroller, 10)
    expect(scroller.scrollTop).toBe(0)
    view.rerender(within(memory, <List memoryKey="p1|view:board" />))
    expect(scroller.scrollTop).toBe(130)
  })

  it('returns to the bottom when the researcher was there', async () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <List memoryKey="p1|view:members" />))
    let scroller = screen.getByTestId('scroller')
    geometry(scroller, 10)
    scroller.scrollTop = 300
    fireEvent.scroll(scroller)
    await frame()
    view.rerender(within(memory, <p>elsewhere</p>))

    // The content is still arriving when the view is back (nothing laid out yet).
    view.rerender(within(memory, <List memoryKey="p1|view:members" rows={14} />))
    scroller = screen.getByTestId('scroller')
    expect(scroller.scrollTop).toBe(0)
    // More content arrives: restoring tries again.
    geometry(scroller, 15)
    view.rerender(within(memory, <List memoryKey="p1|view:members" rows={15} />))
    await act(async () => { await Promise.resolve() })
    expect(scroller.scrollTop).toBe(15 * ROW - 100)
  })

  it('records the position even when the view is left before the next frame', () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <List memoryKey="p1|view:resources" />))
    let scroller = screen.getByTestId('scroller')
    geometry(scroller, 10)
    scroller.scrollTop = 80
    fireEvent.scroll(scroller)
    view.rerender(within(memory, <p>elsewhere</p>))
    view.rerender(within(memory, <List memoryKey="p1|view:resources" ready={false} />))
    scroller = screen.getByTestId('scroller')
    geometry(scroller, 10)
    view.rerender(within(memory, <List memoryKey="p1|view:resources" />))
    expect(scroller.scrollTop).toBe(80)
  })

  it('leaves the list where the researcher put it once they scroll before it is restored', async () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <List memoryKey="p1|view:board" />))
    let scroller = screen.getByTestId('scroller')
    geometry(scroller, 10)
    scroller.scrollTop = 200
    fireEvent.scroll(scroller)
    await frame()
    view.rerender(within(memory, <p>elsewhere</p>))
    view.rerender(within(memory, <List memoryKey="p1|view:board" rows={2} />))
    scroller = screen.getByTestId('scroller')
    fireEvent.wheel(scroller)
    geometry(scroller, 10)
    view.rerender(within(memory, <List memoryKey="p1|view:board" rows={10} />))
    await act(async () => { await Promise.resolve() })
    expect(scroller.scrollTop).toBe(0)
  })

  it('keeps each Workspace’s position apart', async () => {
    const memory = createPlaceMemory()
    const view = render(within(memory, <List memoryKey="p1|view:board" />))
    const scroller = screen.getByTestId('scroller')
    geometry(scroller, 10)
    scroller.scrollTop = 120
    fireEvent.scroll(scroller)
    await frame()
    view.rerender(within(memory, <List key="p2" memoryKey="p2|view:board" />))
    const other = screen.getByTestId('scroller')
    geometry(other, 10)
    expect(other.scrollTop).toBe(0)
  })
})
