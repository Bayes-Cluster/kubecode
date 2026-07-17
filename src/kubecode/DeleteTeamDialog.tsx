import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { TranslationKey, TranslationValues } from '@/lib/i18n'

type Translator = (key: TranslationKey, values?: TranslationValues) => string

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
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!deleting) onOpenChange(nextOpen)
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('kubecode.deleteTeamTitle', { title: teamName })}</DialogTitle>
          <DialogDescription>
            {t('kubecode.deleteTeamDescription', { count: teammateCount })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={deleting} variant="outline">{t('kubecode.cancel')}</Button>
          </DialogClose>
          <Button disabled={deleting} variant="destructive" onClick={() => void confirm()}>
            {t('kubecode.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
