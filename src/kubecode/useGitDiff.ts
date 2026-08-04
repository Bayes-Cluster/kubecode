import { useCallback, useEffect, useRef, useState } from 'react'

import type { GitDiffUnavailableReason, KubecodeApi } from './api'

export type GitDiffTarget = {
  projectId: string
  path: string
  staged: boolean
}

export type GitDiffState =
  | { kind: 'idle' }
  | { kind: 'loading'; target: GitDiffTarget }
  | {
    kind: 'ready'
    target: GitDiffTarget
    content: string | null
    unavailableReason: GitDiffUnavailableReason | null
  }
  | { kind: 'failed'; target: GitDiffTarget; error: unknown }

export function useGitDiff(api: KubecodeApi) {
  const [state, setState] = useState<GitDiffState>({ kind: 'idle' })
  const generationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const open = useCallback((target: GitDiffTarget) => {
    const generation = ++generationRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ kind: 'loading', target })
    api.gitDiff(target.projectId, target.path, target.staged, controller.signal)
      .then((result) => {
        if (generation !== generationRef.current || controller.signal.aborted) return
        abortRef.current = null
        setState({
          kind: 'ready',
          target,
          content: result.diff,
          unavailableReason: result.unavailable_reason,
        })
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current || controller.signal.aborted) return
        abortRef.current = null
        setState({ kind: 'failed', target, error })
      })
  }, [api])

  const close = useCallback(() => {
    generationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setState({ kind: 'idle' })
  }, [])

  useEffect(() => () => {
    generationRef.current += 1
    abortRef.current?.abort()
  }, [])

  return { state, open, close }
}
