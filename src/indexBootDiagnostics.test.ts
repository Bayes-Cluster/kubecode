import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function resizeObserverScriptFromIndex(): string {
  const indexHtml = readFileSync(`${process.cwd()}/index.html`, 'utf8')
  const scripts = [...indexHtml.matchAll(/<script>\s*([\s\S]*?)\s*<\/script>/g)]
  const script = scripts.find((match) => match[1].includes('ResizeObserver loop'))
  if (!script) throw new Error('index.html ResizeObserver startup script was not found')
  return script[1]
}

describe('index startup script', () => {
  it('does not ship a visible boot diagnostics element by default', () => {
    const indexHtml = readFileSync(`${process.cwd()}/index.html`, 'utf8')

    expect(indexHtml).not.toContain('Tolaria boot: HTML parsed')
    expect(indexHtml).not.toContain('<pre id="tolaria-boot-diagnostics"')
  })

  it('does not show the boot overlay for ResizeObserver loop notifications', () => {
    document.body.innerHTML = ''
    new Function(resizeObserverScriptFromIndex())()

    const event = new ErrorEvent('error', {
      cancelable: true,
      message: 'ResizeObserver loop completed with undelivered notifications.',
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(document.body.children).toHaveLength(0)
  })

  it('does not create a visible boot overlay for real startup errors', () => {
    document.body.innerHTML = ''
    new Function(resizeObserverScriptFromIndex())()

    window.dispatchEvent(new ErrorEvent('error', {
      message: 'startup failed',
      filename: 'app.js',
      lineno: 1,
      colno: 2,
    }))

    expect(document.body.children).toHaveLength(0)
  })
})
