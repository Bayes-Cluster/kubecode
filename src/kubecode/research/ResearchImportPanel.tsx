import { useEffect, useId, useRef, useState } from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Item, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type {
  KubecodeApi,
  ResearchDetail,
  ResearchImport,
  ResearchImportDetail,
  ResearchImportOrigin,
} from '../api'
import { newClientMessageId } from '../session/sessionModel'
import {
  CANDIDATE_KIND_ORDER,
  MAX_IMPORT_BYTES,
  proposeBrief,
  utf8Bytes,
  type BriefChange,
} from './researchImport'
import { ResearchSection } from './ResearchLayout'
import { useAction } from './useAction'
import { ReaderLoading, ReaderNotice } from '../resources/ReaderStates'

const FIELD_LABELS: Record<BriefChange['field'], TranslationKey> = {
  question: 'kubecode.research.field.question',
  hypotheses: 'kubecode.research.field.hypotheses',
  constraints: 'kubecode.research.field.constraints',
  evaluation_criteria: 'kubecode.research.field.criteria',
}

/**
 * Imported discussion: text from outside Kubecode kept as attributed source
 * material, then reviewed into the brief only through an explicit,
 * revision-checked comparison. Importing starts no Agent and creates no
 * finding; applying a change is the researcher's own edit under the revision
 * they are looking at.
 */
export function ResearchImportPanel({
  api,
  detail,
  imports,
  importsStatus = 'ready',
  onChanged,
  t,
}: {
  api: KubecodeApi
  detail: ResearchDetail
  imports: ResearchImport[]
  /** A failed list must not read as "nothing imported". */
  importsStatus?: 'error' | 'loading' | 'ready'
  onChanged: () => void
  t: Translator
}) {
  const [label, setLabel] = useState('')
  const [origin, setOrigin] = useState<ResearchImportOrigin>('markdown')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState(false)
  // One key per intended import: a retry after a lost response reuses it.
  const requestKey = useRef(newClientMessageId())
  // Any change to what is imported is a new intent, so a retry after a lost
  // response never reuses a key for different text.
  const rekey = () => {
    requestKey.current = newClientMessageId()
  }
  const importing = useAction(t)
  const [openId, setOpenId] = useState<string | null>(null)
  const bytes = utf8Bytes(content)
  const tooLarge = bytes > MAX_IMPORT_BYTES
  const canImport = !detail.archived && label.trim() !== '' && content.trim() !== '' && !tooLarge

  const submit = async () => {
    if (!canImport) return
    const ok = await importing.run(() => api.createResearchImport(detail.project_id, detail.id, {
      origin,
      label: label.trim(),
      content,
      based_on_revision: detail.revision,
      client_request_id: requestKey.current,
    }))
    if (ok) {
      requestKey.current = newClientMessageId()
      setLabel('')
      setContent('')
      setSaved(true)
      onChanged()
    }
  }

  return (
    <ResearchSection label={t('kubecode.research.import.title')} named>
      <p className="m-0 text-sm text-muted-foreground">{t('kubecode.research.import.intro')}</p>
      {!detail.archived && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('kubecode.research.import.label')}
              className="min-w-[160px] flex-1"
              maxLength={200}
              placeholder={t('kubecode.research.import.labelPlaceholder')}
              value={label}
              onChange={(event) => {
                rekey()
                setSaved(false)
                setLabel(event.target.value)
              }}
            />
            <Select
              value={origin}
              onValueChange={(value) => {
                rekey()
                setOrigin(value as ResearchImportOrigin)
              }}
            >
              <SelectTrigger aria-label={t('kubecode.research.import.origin')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="markdown">{t('kubecode.research.import.originMarkdown')}</SelectItem>
                  <SelectItem value="paste">{t('kubecode.research.import.originPaste')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            aria-label={t('kubecode.research.import.text')}
            placeholder={t('kubecode.research.import.textPlaceholder')}
            rows={6}
            value={content}
            onChange={(event) => {
              rekey()
              setSaved(false)
              setContent(event.target.value)
            }}
          />
          {tooLarge ? (
            <Alert variant="destructive"><AlertDescription>{t('kubecode.research.import.tooLarge')}</AlertDescription></Alert>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">{t('kubecode.research.import.size', { bytes, max: MAX_IMPORT_BYTES })}</p>
          )}
          {importing.error && <Alert variant="destructive"><AlertDescription>{importing.error}</AlertDescription></Alert>}
          {saved && <Alert role="status"><CircleCheck /><AlertDescription>{t('kubecode.research.import.saved')}</AlertDescription></Alert>}
          <div className="flex justify-end">
            <Button aria-busy={importing.busy} disabled={!canImport || importing.busy} size="sm" type="submit">
              {t('kubecode.research.import.submit')}
            </Button>
          </div>
        </form>
      )}
      {importsStatus === 'error' && imports.length === 0 ? (
        <ReaderNotice action={<Button size="xs" variant="outline" onClick={onChanged}>{t('kubecode.retry')}</Button>} failed>
          {t('kubecode.research.import.listFailed')}
        </ReaderNotice>
      ) : imports.length === 0 ? (
        <Empty size="compact">
          <EmptyDescription>{t('kubecode.research.import.empty')}</EmptyDescription>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {imports.map((item) => (
            <Item className="flex-col items-stretch" key={item.id} role="listitem" size="sm" variant="outline">
              <div className="flex flex-wrap items-center gap-2">
                <ItemTitle className="[overflow-wrap:anywhere]">{item.label}</ItemTitle>
                <span className="text-xs text-muted-foreground">
                  {item.origin === 'markdown'
                    ? t('kubecode.research.import.originMarkdown')
                    : t('kubecode.research.import.originPaste')}
                  {' · '}
                  {item.created_at}
                </span>
                <Button
                  aria-controls={`research-import-review-${item.id}`}
                  aria-expanded={openId === item.id}
                  aria-label={t('kubecode.research.import.reviewItem', { label: item.label })}
                  size="xs"
                  variant="outline"
                  onClick={() => setOpenId(openId === item.id ? null : item.id)}
                >
                  {openId === item.id
                    ? t('kubecode.research.import.hideReview')
                    : t('kubecode.research.import.review')}
                </Button>
              </div>
              {item.stale && (
                <Alert role="status">
                  <TriangleAlert />
                  <AlertDescription>
                    {t('kubecode.research.import.stale', {
                      based: item.based_on_revision,
                      current: item.current_revision,
                    })}
                  </AlertDescription>
                </Alert>
              )}
              {openId === item.id && (
                <ImportReview api={api} detail={detail} item={item} onChanged={onChanged} t={t} />
              )}
            </Item>
          ))}
        </ItemGroup>
      )}
    </ResearchSection>
  )
}

/** A short stable digest of a candidate, so an idempotency key names the text itself. */
function textKey(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function ImportReview({
  api,
  detail,
  item,
  onChanged,
  t,
}: {
  api: KubecodeApi
  detail: ResearchDetail
  item: ResearchImport
  onChanged: () => void
  t: Translator
}) {
  const [loaded, setLoaded] = useState<
    { id: string; value: ResearchImportDetail } | { id: string; failed: true } | null
  >(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [applied, setApplied] = useState<number | null>(null)
  // The revision the researcher is reviewing against. If the approved brief
  // moves underneath an open review, nothing is rebased silently: the selection
  // is kept, Apply is held, and the researcher confirms against the new revision.
  const [reviewedRevision, setReviewedRevision] = useState(detail.revision)
  const apply = useAction(t)
  const fieldId = useId()
  const clearApplyError = apply.clearError
  const moved = detail.revision !== reviewedRevision

  useEffect(() => {
    let current = true
    api.getResearchImport(detail.project_id, detail.id, item.id)
      .then((value) => current && setLoaded({ id: item.id, value }))
      .catch(() => current && setLoaded({ id: item.id, failed: true }))
    return () => {
      current = false
    }
  }, [api, detail.id, detail.project_id, item.id])

  useEffect(() => {
    // A message about an older revision must not outlive the revision it was about.
    if (moved) clearApplyError()
  }, [clearApplyError, moved])

  const ready = loaded && loaded.id === item.id ? loaded : null
  if (!ready) {
    return <ReaderLoading>{t('kubecode.loadingContext')}</ReaderLoading>
  }
  if ('failed' in ready) {
    return <Alert variant="destructive"><AlertDescription>{t('kubecode.research.import.loadFailed')}</AlertDescription></Alert>
  }
  const { candidates, content } = ready.value
  const proposal = proposeBrief(detail.brief, candidates, selected)
  const toggle = (index: number, checked: boolean) => setSelected((current) => {
    const next = new Set(current)
    if (!checked) {
      next.delete(index)
      return next
    }
    // At most one candidate replaces the question.
    if (candidates[index].kind === 'question') {
      candidates.forEach((candidate, other) => {
        if (candidate.kind === 'question') next.delete(other)
      })
    }
    next.add(index)
    return next
  })
  const hasChange = proposal.changes.length > 0 || proposal.decisions.length > 0

  const applyChange = () => apply.run(async () => {
    try {
      // Sent under the revision that was reviewed, never the latest one seen: a
      // newer approved brief makes the server refuse (409) instead of being
      // overwritten, and the selection stays.
      if (proposal.changes.length > 0) {
        await api.updateResearch(
          detail.project_id,
          detail.id,
          reviewedRevision,
          proposal.patch,
          undefined,
          item.id,
        )
      }
      for (const decision of proposal.decisions) {
        await api.addResearchEntry(
          detail.project_id,
          detail.id,
          'decision',
          `${decision} (${item.label})`,
          `import-${item.id.slice(0, 8)}-${textKey(decision)}`,
        )
      }
      setApplied(reviewedRevision + (proposal.changes.length > 0 ? 1 : 0))
      setSelected(new Set())
    } finally {
      // Even a partial success changed the brief or the log; show it.
      onChanged()
    }
  })

  return (
    <div
      aria-label={item.label}
      className="mt-2 flex flex-col gap-2"
      id={`research-import-review-${item.id}`}
      role="group"
    >
      {item.stale && (
        <Alert role="status"><TriangleAlert /><AlertDescription>{t('kubecode.research.import.staleWarning')}</AlertDescription></Alert>
      )}
      {moved && (
        <Alert role="status">
          <TriangleAlert />
          <AlertDescription>
          <p>{t('kubecode.research.import.briefChanged', { revision: detail.revision })}</p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setReviewedRevision(detail.revision)
              setApplied(null)
              clearApplyError()
            }}
          >
            {t('kubecode.research.import.reReview', { revision: detail.revision })}
          </Button>
          </AlertDescription>
        </Alert>
      )}
      <pre
        aria-label={t('kubecode.research.import.text')}
        className="m-0 max-h-80 overflow-auto rounded-md border bg-muted p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
        tabIndex={0}
      >
        {content}
      </pre>
      <ResearchSection label={t('kubecode.research.import.candidates')} level={4}>
      <p className="m-0 text-xs text-muted-foreground">{t('kubecode.research.import.candidatesNote')}</p>
      {candidates.length === 0 ? (
        <Empty size="compact">
          <EmptyDescription>{t('kubecode.research.import.noCandidates')}</EmptyDescription>
        </Empty>
      ) : (
        CANDIDATE_KIND_ORDER.map((kind) => {
          const ofKind = candidates
            .map((candidate, index) => ({ candidate, index }))
            .filter(({ candidate }) => candidate.kind === kind)
          if (ofKind.length === 0) return null
          return (
            <FieldSet className="rounded-md border p-3" key={kind}>
              <FieldLegend variant="label">{t(`kubecode.research.import.kind.${kind}`)}</FieldLegend>
              <FieldGroup className="gap-2">
                {ofKind.map(({ candidate, index }) => {
                  const disabled = detail.archived || kind === 'open_question'
                  const controlId = `${fieldId}-candidate-${index}`
                  return (
                    <Field data-disabled={disabled || undefined} key={index} orientation="horizontal">
                      <Checkbox
                        checked={selected.has(index)}
                        disabled={disabled}
                        id={controlId}
                        onCheckedChange={(checked) => toggle(index, checked === true)}
                      />
                      <FieldLabel className="flex-wrap [overflow-wrap:anywhere]" variant="option" htmlFor={controlId}>
                        <span>{candidate.text}</span>
                        <span className="text-muted-foreground">
                          {t('kubecode.research.import.line', { line: candidate.line })}
                        </span>
                      </FieldLabel>
                    </Field>
                  )
                })}
              </FieldGroup>
            </FieldSet>
          )
        })
      )}
      {candidates.some((candidate) => candidate.kind === 'open_question') && (
        <p className="m-0 text-xs text-muted-foreground">{t('kubecode.research.import.openNote')}</p>
      )}
      </ResearchSection>
      <ResearchSection label={t('kubecode.research.import.proposal')} level={4}>
      {!hasChange ? (
        <Empty size="compact">
          <EmptyDescription>{t('kubecode.research.import.proposalNone')}</EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {proposal.changes.length > 0 && (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/4"><span className="sr-only">{t('kubecode.research.import.proposal')}</span></TableHead>
                  <TableHead>{t('kubecode.research.import.before')}</TableHead>
                  <TableHead>{t('kubecode.research.import.after')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proposal.changes.map((change) => (
                  <TableRow key={change.field}>
                    <TableHead scope="row" className="align-top whitespace-normal">{t(FIELD_LABELS[change.field])}</TableHead>
                    <TableCell className="align-top whitespace-pre-line [overflow-wrap:anywhere]">{Array.isArray(change.before) ? change.before.join('\n') || '—' : change.before}</TableCell>
                    <TableCell className="align-top whitespace-pre-line [overflow-wrap:anywhere]">{Array.isArray(change.after) ? change.after.join('\n') : change.after}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {proposal.decisions.length > 0 && (
            <div>
              <p className="m-0 text-xs text-muted-foreground">{t('kubecode.research.import.decisionsNote')}</p>
              <ul className="m-0 list-disc pl-5">{proposal.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      </ResearchSection>
      {proposal.overLimit && (
        <Alert variant="destructive"><AlertDescription>{t('kubecode.research.import.overLimit')}</AlertDescription></Alert>
      )}
      {apply.error && <Alert variant="destructive"><AlertDescription>{apply.error}</AlertDescription></Alert>}
      {applied !== null && !moved && (
        <Alert role="status">
          <CircleCheck />
          <AlertDescription>{t('kubecode.research.import.applied', { revision: applied })}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end">
        <Button
          aria-busy={apply.busy}
          disabled={detail.archived || moved || !hasChange || proposal.overLimit || apply.busy}
          size="sm"
          onClick={() => void applyChange()}
        >
          {t('kubecode.research.import.apply', {
            from: reviewedRevision,
            to: reviewedRevision + (proposal.changes.length > 0 ? 1 : 0),
          })}
        </Button>
      </div>
    </div>
  )
}
