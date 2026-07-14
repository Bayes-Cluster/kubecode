import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import type { KubecodeApi, TerminalInfo } from './api'

type TerminalViewProps = {
  api: KubecodeApi
  projectId: string
  terminal: TerminalInfo
}

export function TerminalView({ api, projectId, terminal }: TerminalViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const cursor = useRef(0)

  useEffect(() => {
    if (!container.current) return
    const xterm = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      theme: { background: '#171717', foreground: '#e5e5e5' },
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(container.current)
    fit.fit()
    const socket = api.terminalSocket(projectId, terminal.id, cursor.current)
    const connectHandlers = () => {
      socket.addEventListener('message', (message) => {
        const event = JSON.parse(String(message.data)) as {
          type: 'output'; data: string; cursor: number; truncated: boolean
        }
        if (event.type !== 'output') return
        if (event.truncated) xterm.reset()
        xterm.write(event.data)
        cursor.current = event.cursor
      })
    }
    connectHandlers()
    const input = xterm.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
      }
    })
    const resize = new ResizeObserver(() => {
      fit.fit()
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }))
      }
    })
    resize.observe(container.current)
    return () => {
      resize.disconnect()
      input.dispose()
      socket.close()
      xterm.dispose()
    }
  }, [api, projectId, terminal.id])

  return <div className="kubecode-terminal-view" ref={container} />
}
