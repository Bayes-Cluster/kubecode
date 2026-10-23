import { useState } from 'react'
import { RotateCw, TriangleAlert, Users } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi } from '../api'
import { agentName } from '../session/sessionModel'
import { memberErrorMessage, type ManagerSetup } from './memberModel'

export type ManagerSetupNoticeProps = {
  api: KubecodeApi
  projectId: string
  setup: ManagerSetup
  t: Translator
  /** Opens Members, on the manager's profile when there is one. */
  onOpenMembers: (memberId: string | null) => void
  /** Reads the roster again after a retry. */
  onReload: () => void
}

/**
 * The recovery state of a Workspace whose project manager is not ready
 * (#235): General says why, retries setup in place, and points at Members to
 * change the provider. A ready manager or a roster still loading shows nothing.
 */
export function ManagerSetupNotice({ api, onOpenMembers, onReload, projectId, setup, t }: ManagerSetupNoticeProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (setup.kind !== 'needs_setup' && setup.kind !== 'missing') return null
  const manager = setup.kind === 'needs_setup' ? setup.manager : null
  const reason = !manager
    ? t('kubecode.members.managerSetup.missing')
    : manager.setup_code === 'provider_unavailable'
      ? t('kubecode.members.setup.providerUnavailable', { provider: agentName(manager.spec.agent_id) })
      : manager.setup_code === 'config_rejected'
        ? `${t('kubecode.members.setup.configRejected')}${manager.setup_error ? ` (${manager.setup_error})` : ''}`
        : manager.setup_error ?? t('kubecode.members.managerSetup.pending')

  const retry = async () => {
    if (!manager) return
    setBusy(true)
    setError(null)
    try {
      await api.retryMemberSetup(projectId, manager.id)
      onReload()
    } catch (cause) {
      setError(memberErrorMessage(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Alert className="mx-4 mt-3 w-auto shrink-0 max-md:mx-3 max-md:mt-2">
      <TriangleAlert aria-hidden />
      <AlertTitle>{t('kubecode.members.managerSetup.title')}</AlertTitle>
      <AlertDescription>
        <p>{reason}</p>
        {error && <p className="text-destructive">{error}</p>}
      </AlertDescription>
      <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">
        {manager && (
          <Button disabled={busy} size="sm" variant="default" onClick={() => void retry()}>
            <RotateCw data-icon="inline-start" />
            {t('kubecode.members.retrySetup')}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => onOpenMembers(manager?.id ?? null)}>
          <Users data-icon="inline-start" />
          {t('kubecode.members.managerSetup.openMembers')}
        </Button>
      </div>
    </Alert>
  )
}
