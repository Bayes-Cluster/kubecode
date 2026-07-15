import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'

// Stub fetch to prevent jsdom@28 + Node 22 undici incompatibility.
// jsdom's JSDOMDispatcher passes an onError handler that Node 22's bundled
// undici rejects with InvalidArgumentError (UND_ERR_INVALID_ARG).
// Tests should never make real network requests — individual tests can
// override this stub via vi.mocked(fetch).mockImplementation(...).
const defaultFetchMock = () => Promise.resolve(new Response(null, { status: 418 }))
globalThis.fetch = vi.fn(defaultFetchMock) as typeof globalThis.fetch

// Stub WebSocket to prevent Node 22 + undici WebSocket incompatibility.
// undici's WebSocket dispatchEvent crashes with "The event argument must be
// an instance of Event" when running in jsdom environment.
// Tests should never open real WebSocket connections.
globalThis.WebSocket = class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  constructor(/* url: string, protocols?: string | string[] */) {
    // No-op: don't open real connections in tests
  }
  send(/* data: unknown */) {}
  close() { this.readyState = MockWebSocket.CLOSED }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true }
} as unknown as typeof WebSocket

// Mock scrollIntoView for jsdom (not implemented)
Element.prototype.scrollIntoView = vi.fn()

// Mock ResizeObserver for jsdom (not implemented)
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// Mock IntersectionObserver for jsdom (not implemented)
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof IntersectionObserver

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  if (vi.isMockFunction(globalThis.fetch)) {
    vi.mocked(globalThis.fetch).mockReset().mockImplementation(defaultFetchMock)
  } else {
    globalThis.fetch = vi.fn(defaultFetchMock) as typeof globalThis.fetch
  }
})
