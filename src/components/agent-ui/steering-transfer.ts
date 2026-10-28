import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { playFlip, readRect, type FlipRect } from './flip'
import { prefersReducedMotion } from '@/lib/reducedMotion'

/**
 * ADR 0257, adapting the affectUI Agent Steering transfer
 * (https://www.affectui.com/components/agent-steering, Clean preview,
 * captured 2026-10-26) to Kubecode's real admission events: when a queued
 * prompt is confirmed — the queue item vanishes from the snapshot and a run
 * carrying the same `client_message_id` appears — the new run receipt row
 * glides from the queue row's last position (~620 ms, interruptible), then
 * carries a brief landed highlight. The identity is explicit (the client
 * message id), never inferred from text or order, and queue disappearance
 * without such a run is treated as plain removal: no transfer plays.
 *
 * Deviations: no plan-step landing (the plan model has no stable step
 * identity); reduced motion plays no glide and the landed state appears
 * immediately; the dock keeps its snapshot-driven order (no local
 * reordering). Durations: 620 ms transfer, 1200 ms landed — presentation
 * tokens, not behavior gates.
 *
 * Usage: `source(id)` is the dock row's ref (registered by client message
 * id); `request(clientMessageId, runId)` fires in two phases — the queue
 * snapshot dropping the id marks it pending, and the run carrying it
 * attaching confirms — seeking the receipt row by its run id via
 * `[data-message-id="…"]`. The landed state's evidence is
 * the unit suite and the live Session workspace; `#/controls` does not
 * mount a fake queue (the dock is snapshot-driven, and a mock would teach
 * the wrong contract). Motion captures defer to slice L (#289).
 */

const TRANSFER_MS = 620
const LANDED_MS = 1200
/** How long the receipt may take to appear after the queue row is gone. */
const TARGET_WAIT_MS = 700

export const STEERING_LANDED_ATTRIBUTE = 'data-steering-landed'

export function useSteeringTransfer() {
  const sources = useRef(new Map<string, { element: HTMLElement; rect: FlipRect }>())
  const frame = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelAnimationFrame(frame.current)
    }
  }, [])

  // The dock row's last known box, refreshed after every commit while the
  // row lives — the snapshot that removes it leaves no time to measure.
  const refreshSources = useCallback(() => {
    for (const record of sources.current.values()) {
      record.rect = readRect(record.element)
    }
  }, [])

  useLayoutEffect(refreshSources)

  const source = useCallback((id: string) => (element: HTMLElement | null) => {
    if (element) sources.current.set(id, { element, rect: readRect(element) })
    else sources.current.delete(id)
  }, [])

  const request = useCallback((id: string) => {
    const reduced = prefersReducedMotion()
    const first = sources.current.get(id)?.rect
    if (!first) return
    sources.current.delete(id)
    const started = performance.now()
    const seek = () => {
      if (!mounted.current) return
      const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
      if (target) {
        // Reduced motion lands in the same final state, without the glide.
        if (!reduced) playFlip(target, first, { duration: TRANSFER_MS })
        if (mounted.current) {
          target.setAttribute(STEERING_LANDED_ATTRIBUTE, '')
          window.setTimeout(() => {
            if (mounted.current) target.removeAttribute(STEERING_LANDED_ATTRIBUTE)
          }, LANDED_MS)
        }
        return
      }
      if (performance.now() - started < TARGET_WAIT_MS) {
        frame.current = requestAnimationFrame(seek)
      }
    }
    frame.current = requestAnimationFrame(seek)
  }, [])

  return { request, source }
}
