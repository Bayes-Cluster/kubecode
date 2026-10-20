import { useCallback } from 'react'

import { useWorkspaceNavigation } from '../app/location/WorkspaceNavigation'

/**
 * Shows a General message about a Task, with General narrowed to the Task and
 * no Thread over it; beside General the Task stays open (ADR 0223 §3).
 */
export function useShowInGeneral(taskId: string) {
  const { openPlace } = useWorkspaceNavigation()
  return useCallback((messageId: string) => openPlace(
    { view: 'general', filter: taskId, message: messageId, thread: null },
    { carryInspector: 'when-side' },
  ), [openPlace, taskId])
}
