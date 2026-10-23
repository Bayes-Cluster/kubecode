import { useId, useState } from 'react'

import { MarkdownContent } from '@/components/MarkdownContent'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import { ReferenceChip } from '@/components/workspace/ReferenceChip'
import type { Translator } from '@/lib/i18n'

import type { ChannelMessage, DmSharePreview, DmTurn, KubecodeApi, Member, ResearchSummary } from '../api'
import { ApiError } from '../api'
import { errorMessage } from '../app/errors'
import { Identity } from '../members/Identity'
import { canReceive, useMemberDirectory } from '../members/memberDirectory'
import { memberView, researcherView } from '../members/memberIdentity'
import { newClientMessageId } from '../session/sessionModel'

/** Turns one share may carry (the server enforces the same bound). */
const MAX_TURNS = 6
/** The Select cannot hold an empty value: "No Task" has its own. */
const NO_TASK = '__none__'

export type DmShareDialogProps = {
  api: KubecodeApi
  member: Member
  open: boolean
  projectId: string
  research: ResearchSummary[]
  t: Translator
  turns: DmTurn[]
  onOpenChange: (open: boolean) => void
  /** The message it became in General. */
  onShared: (message: ChannelMessage) => void
}

/**
 * What a share would post, as General will show it (ADR 0229 §6): from the
 * researcher, to the project manager, about its Task, rendered the same way,
 * with the exact text a disclosure away.
 */
function DmSharePreviewCard({ preview, research, t }: { preview: DmSharePreview; research: ResearchSummary[]; t: Translator }) {
  const { manager } = useMemberDirectory()
  const reachable = manager !== null && canReceive(manager)
  const managerView = manager ? memberView(manager, t) : null
  // A manager who is active but has no Session yet still cannot receive it: say so on the name too.
  const shown = managerView && !reachable && !managerView.attention
    ? { ...managerView, attention: { label: t('kubecode.identity.cannotReceive'), tone: 'warn' as const } }
    : managerView
  const [exact, setExact] = useState(false)
  const task = preview.task_id ? research.find((item) => item.id === preview.task_id) : undefined
  return (
    <Card aria-label={t('kubecode.dm.sharePreview')} className="min-w-0 gap-3 py-3" role="region">
      <CardHeader className="flex flex-wrap items-center gap-2 px-3">
        <Identity size="sm" view={researcherView(t)} />
        <p className="m-0 inline-flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>{t('kubecode.channel.to')}</span>
          {shown && <Identity size="sm" view={shown} />}
        </p>
        {preview.task_id && (
          <ReferenceChip
            kind="task"
            kindLabel={t('kubecode.vocab.object.task')}
            title={task?.title ?? t('kubecode.reference.untitled', { kind: t('kubecode.vocab.object.task') })}
          />
        )}
      </CardHeader>
      <CardContent className="kubecode-message-body px-3">
        <MarkdownContent content={preview.text} images="text" />
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-2 px-3">
        {manager && reachable
          ? <p className="text-sm text-muted-foreground">{t('kubecode.dm.shareRecipients', { name: manager.name })}</p>
          : (
            <Alert role="status">
              <AlertDescription>{t('kubecode.channel.noRecipient')}</AlertDescription>
            </Alert>
          )}
        <Collapsible open={exact} onOpenChange={setExact}>
          <CollapsibleTrigger asChild>
            <Button size="xs" variant="ghost">{t('kubecode.dm.shareExactText')}</Button>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount hidden={!exact}>
            <pre className="whitespace-pre-wrap break-words text-xs">{preview.text}</pre>
          </CollapsibleContent>
        </Collapsible>
      </CardFooter>
    </Card>
  )
}

/**
 * Moves part of a private conversation into General, and only that part: the
 * researcher picks turns, may add a note, reads what would be posted as it
 * will look, and confirms that same text. Changing anything invalidates the
 * preview, and the server refuses a confirmation of text that no longer matches.
 */
export function DmShareDialog({
  api,
  member,
  onOpenChange,
  onShared,
  open,
  projectId,
  research,
  t,
  turns,
}: DmShareDialogProps) {
  const fieldId = useId()
  const [chosen, setChosen] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [taskId, setTaskId] = useState('')
  // The preview remembers what it was made from; one id belongs to one
  // confirmation, so a deliberate second share is a second message.
  const [made, setMade] = useState<{ preview: DmSharePreview; key: string; clientMessageId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const request = () => ({
    runIds: turns.filter((turn) => chosen.includes(turn.run_id)).map((turn) => turn.run_id),
    note: note.trim() || undefined,
    taskId: taskId || null,
  })
  // A preview counts only for exactly what is selected now (the turns on
  // offer can change underneath a selection).
  const current = JSON.stringify(request())
  const preview = made && made.key === current ? made.preview : null

  const close = (next: boolean) => {
    if (!next) {
      setChosen([])
      setNote('')
      setTaskId('')
      setMade(null)
      setError(null)
    }
    onOpenChange(next)
  }

  const changed = (action: () => void) => {
    // Any change to what would be shared makes the previous preview stale.
    action()
    setMade(null)
    setError(null)
  }

  const toggle = (runId: string) => changed(() => setChosen((selected) => (
    selected.includes(runId)
      ? selected.filter((id) => id !== runId)
      : selected.length < MAX_TURNS ? [...selected, runId] : selected
  )))

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'dm_share_stale') {
        setMade(null)
        setError(t('kubecode.dm.shareStale'))
      } else {
        setError(errorMessage(cause, t('kubecode.error')))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('kubecode.dm.shareTitle', { name: member.name })}</DialogTitle>
          <DialogDescription>{t('kubecode.dm.shareHelp')}</DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <FieldSet className="max-h-56 overflow-y-auto">
            <FieldLegend variant="label">{t('kubecode.dm.shareChoose')}</FieldLegend>
            <FieldDescription>{t('kubecode.dm.shareCount', { count: chosen.length, max: MAX_TURNS })}</FieldDescription>
            {turns.length === 0 && <FieldDescription>{t('kubecode.dm.empty')}</FieldDescription>}
            {turns.map((turn) => {
              const checked = chosen.includes(turn.run_id)
              const id = `${fieldId}-turn-${turn.run_id}`
              return (
                <Field key={turn.run_id} orientation="horizontal">
                  <Checkbox
                    checked={checked}
                    disabled={!checked && chosen.length >= MAX_TURNS}
                    id={id}
                    onCheckedChange={() => toggle(turn.run_id)}
                  />
                  <FieldLabel className="min-w-0 font-normal [overflow-wrap:anywhere]" htmlFor={id}>
                    {turn.user.slice(0, 120) || turn.run_id.slice(0, 8)}
                  </FieldLabel>
                </Field>
              )
            })}
          </FieldSet>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-note`}>{t('kubecode.dm.shareNote')}</FieldLabel>
            <Textarea id={`${fieldId}-note`} rows={2} value={note} onChange={(event) => changed(() => setNote(event.target.value))} />
          </Field>
          {research.length > 0 && (
            <Field>
              <FieldLabel htmlFor={`${fieldId}-task`}>{t('kubecode.dm.shareTask')}</FieldLabel>
              <Select
                value={taskId || NO_TASK}
                onValueChange={(next) => changed(() => setTaskId(next === NO_TASK ? '' : next))}
              >
                <SelectTrigger className="w-full" id={`${fieldId}-task`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NO_TASK}>{t('kubecode.dm.shareNoTask')}</SelectItem>
                    {research.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        </FieldGroup>
        {preview && <DmSharePreviewCard preview={preview} research={research} t={t} />}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          {preview ? (
            <DecisionButton
              busy={busy}
              variant="primary"
              onDecide={() => void run(async () => {
                const message = await api.shareDm(projectId, member.id, {
                  ...request(),
                  digest: preview.digest,
                  clientMessageId: made?.clientMessageId,
                })
                onShared(message)
                close(false)
              })}
            >
              {t('kubecode.dm.shareConfirm')}
            </DecisionButton>
          ) : (
            <Button
              disabled={busy || chosen.length === 0}
              size="sm"
              onClick={() => void run(async () => {
                const key = JSON.stringify(request())
                setMade({
                  preview: await api.previewDmShare(projectId, member.id, request()),
                  key,
                  clientMessageId: newClientMessageId(),
                })
              })}
            >
              {t('kubecode.dm.sharePreviewAction')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => close(false)}>
            {t('kubecode.members.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
