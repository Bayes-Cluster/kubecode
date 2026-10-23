import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'

type DeleteTeamDialogProps = {
  onConfirm: () => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
  t: Translator
  teamName: string
  teammateCount: number
}

export function DeleteTeamDialog({
  onConfirm,
  onOpenChange,
  open,
  t,
  teamName,
  teammateCount,
}: DeleteTeamDialogProps) {
  const [deleting, setDeleting] = useState(false)

  const confirm = async () => {
    setDeleting(true)
    try {
      await onConfirm()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => {
      if (!deleting) onOpenChange(nextOpen)
    }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('kubecode.deleteTeamTitle', { title: teamName })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('kubecode.deleteTeamDescription', { count: teammateCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t('kubecode.cancel')}</AlertDialogCancel>
          {/* Not AlertDialogAction: the dialog stays until the Team is deleted. */}
          <Button aria-busy={deleting} disabled={deleting} variant="destructive" onClick={() => void confirm()}>
            {deleting && <Spinner data-icon="inline-start" />}
            {t('kubecode.delete')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
