import { useEffect, useRef, useState } from 'react'

import type { KubecodeApi, Member } from '../../api'

export type DmTarget = { status: 'idle' | 'loading' | 'ready' | 'error'; member: Member | null }

type Opened = { member: Member } | { error: unknown }

/**
 * The member a private-conversation place names, by id (ADR 0228 §2). The
 * place holds only the member id; the Member with its conversation comes from
 * the roster when the conversation already exists, and is otherwise opened
 * once per Workspace and member. A result for another Workspace or member is
 * never shown. `roster` is `null` while it loads.
 */
export function useDmTarget(
  api: KubecodeApi,
  projectId: string | null,
  memberId: string | null,
  roster: readonly Member[] | null,
  onError?: (cause: unknown) => void,
): DmTarget {
  const key = projectId && memberId ? `${projectId}|${memberId}` : null
  const known = memberId
    ? roster?.find((member) => member.id === memberId && member.dm_conversation_id) ?? null
    : null
  const [opened, setOpened] = useState<Record<string, Opened>>({})
  const requested = useRef(new Set<string>())
  const currentKey = useRef(key)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    currentKey.current = key
    onErrorRef.current = onError
  })

  const needsOpening = key !== null && known === null && roster !== null
  useEffect(() => {
    if (!needsOpening || !key || !projectId || !memberId || requested.current.has(key)) return
    requested.current.add(key)
    api.openMemberDm(projectId, memberId).then(
      (member) => setOpened((current) => ({ ...current, [key]: { member } })),
      (cause: unknown) => {
        setOpened((current) => ({ ...current, [key]: { error: cause } }))
        if (currentKey.current === key) onErrorRef.current?.(cause)
      },
    )
  }, [api, key, memberId, needsOpening, projectId])

  if (!key) return { status: 'idle', member: null }
  if (known) return { status: 'ready', member: known }
  const result = opened[key]
  if (!result) return { status: 'loading', member: null }
  return 'member' in result ? { status: 'ready', member: result.member } : { status: 'error', member: null }
}
