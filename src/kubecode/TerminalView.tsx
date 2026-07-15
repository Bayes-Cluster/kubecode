import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import type { KubecodeApi, TerminalInfo } from './api'
import {
  readTerminalSnapshot,
  removeTerminalSnapshot,
  writeTerminalSnapshot,
} from './terminalSnapshots'

type TerminalViewProps = {
  api: KubecodeApi
  fontFamily: string
  projectId: string
  terminal: TerminalInfo
  visible: boolean
  onStatus: (terminal: TerminalInfo) => void
}

export function TerminalView({ api, fontFamily, onStatus, projectId, terminal, visible }: TerminalViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const fitAddon = useRef<FitAddon>(null)
  const xtermRef = useRef<Terminal>(null)
  const terminalRef = useRef(terminal)
  const visibleRef = useRef(visible)
  const fontFamilyRef = useRef(fontFamily)

  useEffect(() => {
    terminalRef.current = terminal
  }, [terminal])

  useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  useEffect(() => {
    fontFamilyRef.current = fontFamily
    if (!xtermRef.current) return
    xtermRef.current.options.fontFamily = fontFamily
    fitAddon.current?.fit()
  }, [fontFamily])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fitAddon.current?.fit()
      xtermRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  useEffect(() => {
    if (!container.current) return
    const snapshot = readTerminalSnapshot(projectId, terminal.id)
    let cursor = snapshot?.cursor ?? 0
    const xterm = new Terminal({
      cursorBlink: true,
      convertEol: true,
      cols: snapshot?.cols,
      rows: snapshot?.rows,
      fontFamily: fontFamilyRef.current,
      fontSize: 14,
      scrollback: 10_000,
      theme: { background: '#171717', foreground: '#e5e5e5' },
    })
    const fit = new FitAddon()
    const serialize = new SerializeAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(serialize)
    xterm.open(container.current)
    fitAddon.current = fit
    xtermRef.current = xterm
    if (snapshot?.buffer) {
      xterm.write(snapshot.buffer, () => xterm.scrollToLine(snapshot.scrollY))
    }
    if (visibleRef.current) fit.fit()
    const socket = api.terminalSocket(projectId, terminal.id, cursor)
    socket.addEventListener('message', (message) => {
      const event = JSON.parse(String(message.data)) as TerminalSocketMessage
      if (event.type === 'status') {
        onStatus({
          ...terminalRef.current,
          status: event.status,
          exit_code: event.exit_code,
          signal: event.signal,
        })
        return
      }
      if (event.type !== 'output') return
      if (event.truncated) {
        xterm.reset()
        removeTerminalSnapshot(projectId, terminal.id)
      }
      xterm.write(event.data)
      cursor = event.cursor
    })
    const input = xterm.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
      }
    })
    const resize = new ResizeObserver(() => {
      if (!visibleRef.current || !container.current?.clientWidth || !container.current.clientHeight) return
      fit.fit()
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }))
      }
    })
    resize.observe(container.current)
    return () => {
      writeTerminalSnapshot(projectId, terminal.id, {
        buffer: serialize.serialize({ scrollback: 2_000 }),
        cols: xterm.cols,
        cursor,
        rows: xterm.rows,
        scrollY: xterm.buffer.active.viewportY,
      })
      resize.disconnect()
      input.dispose()
      socket.close()
      serialize.dispose()
      xterm.dispose()
      fitAddon.current = null
      xtermRef.current = null
    }
  }, [api, onStatus, projectId, terminal.id])

  return <div className="kubecode-terminal-view" ref={container} />
}

type TerminalSocketMessage =
  | { type: 'output'; data: string; cursor: number; truncated: boolean }
  | {
    type: 'status'
    status: 'running' | 'exited'
    exit_code: number | null
    signal: string | null
  }
