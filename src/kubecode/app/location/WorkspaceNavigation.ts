/**
 * How feature slices move the researcher (ADR 0228): to a place in the active
 * Workspace, into its inspector, to execution history, or to another
 * Workspace. The shell provides it; slices import this module and never the
 * shell.
 */

import { createContext, useContext } from 'react'

import type { ProjectContextRef } from '../../api'
import type { InspectorPresentation } from '../inspector/useInspectorPresentation'
import type { InspectMode, InspectorEntry } from './inspector'
import type { GeneralPatch, PlaceTarget, WorkspaceLocation } from './workspaceLocation'

export type OpenPlaceOptions = {
  /** Opens this entry over the place, replacing its remembered stack. */
  inspect?: InspectorEntry
  /**
   * `remembered` (default): the place's own stack; `keep`: the stack on screen
   * now; `closed`: no inspector, so what the move is for (a Thread, a message)
   * is not hidden under one the place remembered.
   */
  inspector?: 'keep' | 'remembered' | 'closed'
  /** A `data-focus-key` to focus on arrival. */
  focus?: string
  /** `when-side`: keep the open inspector when it is shown beside the view. */
  carryInspector?: 'never' | 'when-side'
}

export type WorkspaceNavigation = {
  projectId: string
  location: WorkspaceLocation
  presentation: InspectorPresentation
  openPlace(target: PlaceTarget, options?: OpenPlaceOptions): void
  patchGeneral(patch: GeneralPatch): void
  /** `from` is the `data-focus-key` to return focus to. */
  inspect(entry: InspectorEntry, options?: { mode?: InspectMode; from?: string }): void
  /** Keeps the message in General's place and opens the Task over it. */
  openTaskFromMessage(taskId: string, messageId: string): void
  /** Opens a reference the same way everywhere (`inspectorTargetForReference`). */
  openReference(ref: ProjectContextRef): void
  /** The only way into execution history. */
  openSession(conversationId: string, projectId?: string): void
  switchWorkspace(projectId: string): void
}

export const WorkspaceNavigationContext = createContext<WorkspaceNavigation | null>(null)

export function useWorkspaceNavigation(): WorkspaceNavigation {
  const value = useContext(WorkspaceNavigationContext)
  if (!value) throw new Error('useWorkspaceNavigation is used outside the Workspace shell')
  return value
}
