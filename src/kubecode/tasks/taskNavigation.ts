import { useCallback } from 'react'

import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'

/**
 * Goes from a Task to the one General conversation (ADR 0223 §3), never
 * under a Thread. Beside General the Task stays open; over it, as on a phone,
 * General replaces it (browser Back returns) and never shows a Task General
 * happened to remember instead.
 */
export function useGeneralFromTask() {
  const { openPlace, presentation } = useWorkspaceNavigation()
  return useCallback((
    target: { message?: string | null; filter?: string | null },
    focus?: string,
  ) => openPlace(
    { view: 'general', message: target.message ?? null, filter: target.filter ?? null, thread: null },
    { inspector: presentation === 'side' ? 'keep' : 'closed', ...(focus ? { focus } : {}) },
  ), [openPlace, presentation])
}

/** Shows a General message about a Task, with General narrowed to the Task. */
export function useShowInGeneral(taskId: string) {
  const general = useGeneralFromTask()
  return useCallback((messageId: string) => general({ message: messageId, filter: taskId }), [general, taskId])
}
