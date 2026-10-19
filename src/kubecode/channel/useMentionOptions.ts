import { useMemo } from 'react'

import type { MentionOption } from '@/components/workspace/mentions'

import type { KubecodeApi, WorkspaceEvent } from '../api'
import { useMembers } from '../members/useMembers'
import type { WorkspaceConnectionState } from '../useWorkspaceEventStream'

/**
 * The members a message can `@mention`: live members that have a Session to
 * address. The option id is the Session recorded as the mention.
 */
export function useMentionOptions(
  api: KubecodeApi,
  projectId: string | null,
  events: WorkspaceEvent[],
  connectionState: WorkspaceConnectionState,
): MentionOption[] {
  const { roster } = useMembers(api, projectId, events, connectionState)
  return useMemo(
    () => (roster?.members ?? [])
      .filter((member) => member.state === 'active' && member.public_conversation_id !== null)
      .map((member) => ({
        id: member.public_conversation_id as string,
        handle: member.handle,
        label: member.name,
      })),
    [roster],
  )
}
