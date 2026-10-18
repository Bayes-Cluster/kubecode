import { useCallback, useRef, useState } from 'react'

import type { Translator } from '@/lib/i18n'

import { ApiError } from '../api'
import { errorMessage } from '../app/errors'

/** The message for a failed research command; conflicts name what to do. */
export function researchErrorMessage(cause: unknown, t: Translator): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'research_revision_conflict') return t('kubecode.research.error.revisionConflict')
    if (cause.code === 'research_archived') return t('kubecode.research.error.archived')
    if (cause.code === 'research_link_conflict') return t('kubecode.research.error.linkConflict')
    if (cause.code === 'research_review_conflict') return t('kubecode.research.error.reviewConflict')
    if (cause.code === 'research_not_found') return t('kubecode.research.error.notFound')
    if (cause.code === 'research_import_not_found') return t('kubecode.research.error.importNotFound')
    if (cause.code === 'research_request_key_reused') return t('kubecode.research.error.keyReused')
    if (cause.code === 'envelope_revision_conflict') return t('kubecode.research.exec.error.conflict')
  }
  return errorMessage(cause, t('kubecode.error'))
}

/**
 * Runs one command at a time, exposing busy and error state. Returns whether
 * the command succeeded so callers can reset their forms.
 */
export function useAction(t: Translator, onFailure?: (cause: unknown) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const run = useCallback(async (command: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setError(null)
    try {
      await command()
      return true
    } catch (cause) {
      setError(researchErrorMessage(cause, t))
      onFailure?.(cause)
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [onFailure, t])
  return { busy, error, run, clearError: useCallback(() => setError(null), []) }
}
