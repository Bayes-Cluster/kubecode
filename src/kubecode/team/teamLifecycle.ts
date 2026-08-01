import { useEffect, useMemo } from 'react'

import { trackEvent } from '@/lib/telemetry'

import type { TeamSnapshot } from '../api'

export function useTeamLifecycleEvents(snapshot: TeamSnapshot) {
  const activity = useMemo(() => snapshot.activity ?? [], [snapshot.activity])

  useEffect(() => {
    if (!activity.some((item) => item.kind === 'team_native_permission_restored')) return
    const key = `kubecode:team-native-permission-restored:${snapshot.team.id}`
    if (globalThis.sessionStorage?.getItem(key)) return
    globalThis.sessionStorage?.setItem(key, '1')
    trackEvent('kubecode_team_native_permission_restored', {
      requested_mode: snapshot.team.requested_mode,
    })
  }, [activity, snapshot.team.id, snapshot.team.requested_mode])

  useEffect(() => {
    for (const item of activity) {
      if (item.kind === 'leader_no_progress') {
        trackTeamLifecycleEvent('kubecode_team_leader_no_progress', String(item.id), item.kind)
      }
    }
  }, [activity])

  useEffect(() => {
    for (const request of snapshot.user_input_requests ?? []) {
      trackTeamLifecycleEvent('kubecode_team_user_input_requested', request.id, request.status)
    }
    for (const operation of snapshot.lifecycle_operations ?? []) {
      if (operation.kind === 'provisioning' && operation.status === 'failed') {
        trackTeamLifecycleEvent(
          'kubecode_team_member_provision_failed',
          operation.id,
          operation.status,
        )
      }
    }
  }, [snapshot.lifecycle_operations, snapshot.user_input_requests])
}

function trackTeamLifecycleEvent(
  event: string,
  id: string,
  status: string,
  properties: Record<string, string | number> = {},
) {
  const key = `kubecode:team-lifecycle:${event}:${id}:${status}`
  if (globalThis.sessionStorage?.getItem(key)) return
  globalThis.sessionStorage?.setItem(key, '1')
  trackEvent(event, properties)
}
