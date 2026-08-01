import { useState } from 'react'
import { Pause } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Translator } from '@/lib/i18n'

import type { KubecodeApi, TeamSnapshot } from './api'
import { TeamProposalView } from './team/TeamProposalView'
import { TeamSetup } from './team/TeamSetupView'
import { TeamStatusView } from './team/TeamStatusView'
import { TeamTasksView } from './team/TeamTasksView'
import { TeamVerificationView } from './team/TeamVerificationView'
import { useTeamLifecycleEvents } from './team/teamLifecycle'

export function TeamWorkspaceView({
  api,
  onSelectMember,
  onSnapshotChange,
  snapshot,
  t,
}: {
  api: KubecodeApi
  onSelectMember: (conversationId: string) => void
  onSnapshotChange: (snapshot: TeamSnapshot) => void
  snapshot: TeamSnapshot
  t: Translator
}) {
  const [error, setError] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [pauseConfirmationOpen, setPauseConfirmationOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  useTeamLifecycleEvents(snapshot)

  const updateTeam = async (action: string, request: () => Promise<TeamSnapshot>) => {
    setBusyAction(action)
    setError(null)
    try {
      onSnapshotChange(await request())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('kubecode.error'))
    } finally {
      setBusyAction(null)
    }
  }

  const pause = async () => {
    setPauseConfirmationOpen(false)
    await updateTeam('pause', () => api.pauseTeam(snapshot.team.id))
  }

  const resolveProposal = async (decision: 'approved' | 'rejected') => {
    if (!snapshot.proposal) return
    await updateTeam(`proposal:${decision}`, () => api.resolveTeamProposal(
      snapshot.team.id,
      snapshot.proposal!.id,
      decision,
    ))
  }

  if (snapshot.team.status === 'draft' || setupOpen) {
    return (
      <TeamSetup
        api={api}
        onCancel={snapshot.team.status === 'draft' ? undefined : () => setSetupOpen(false)}
        onSnapshotChange={onSnapshotChange}
        snapshot={snapshot}
        t={t}
      />
    )
  }

  return (
    <section className="kubecode-team-workspace" data-testid="team-workspace-view">
      <TeamStatusView
        api={api}
        busyAction={busyAction}
        error={error}
        onPause={() => setPauseConfirmationOpen(true)}
        onReconfigure={() => setSetupOpen(true)}
        onResume={() => void updateTeam('resume', () => api.resumeTeam(snapshot.team.id))}
        onSelectMember={onSelectMember}
        onSnapshotChange={onSnapshotChange}
        setError={setError}
        snapshot={snapshot}
        t={t}
      />

      {snapshot.proposal?.status === 'pending' && (
        <TeamProposalView
          busyAction={busyAction}
          onResolve={resolveProposal}
          proposal={snapshot.proposal}
          t={t}
        />
      )}

      <TeamVerificationView rounds={snapshot.discrimination_rounds ?? []} t={t} />

      <TeamTasksView
        api={api}
        busyAction={busyAction}
        onSelectMember={onSelectMember}
        onSnapshotChange={onSnapshotChange}
        setBusyAction={setBusyAction}
        setError={setError}
        snapshot={snapshot}
        t={t}
      />

      <Dialog open={pauseConfirmationOpen} onOpenChange={setPauseConfirmationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.teamPauseTitle')}</DialogTitle>
            <DialogDescription>{t('kubecode.teamPauseDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPauseConfirmationOpen(false)}>
              {t('kubecode.cancel')}
            </Button>
            <Button onClick={() => void pause()}>
              <Pause weight="fill" /> {t('kubecode.teamPauseConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
