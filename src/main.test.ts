import { beforeEach, describe, expect, it, vi } from 'vitest'

const rootMocks = vi.hoisted(() => {
  const render = vi.fn()
  return {
    createRoot: vi.fn(() => ({ render })),
    render,
  }
})

vi.mock('react-dom/client', () => ({ createRoot: rootMocks.createRoot }))
vi.mock('@/kubecode/App', () => ({ KubecodeApp: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: unknown }) => children,
}))

describe('browser entry point', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    rootMocks.createRoot.mockClear()
    rootMocks.render.mockClear()
  })

  it('mounts the Kubecode workbench into the root element', async () => {
    await import('./main')

    expect(rootMocks.createRoot).toHaveBeenCalledWith(document.getElementById('root'))
    expect(rootMocks.render).toHaveBeenCalledOnce()
  })
})
