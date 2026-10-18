import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { useAction } from './useAction'

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
  onChanged,
  t,
}: {
  api: KubecodeApi
  detail: ResearchDetail
  imports: ResearchImport[]
  onChanged: () => void
  t: Translator
}) {
  const [label, setLabel] = useState('')
  const [origin, setOrigin] = useState<ResearchImportOrigin>('markdown')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState(false)
  // One key per intended import: a retry after a lost response reuses it.
  const requestKey = useRef(newClientMessageId())
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
    <section className="kubecode-research-section" aria-label={t('kubecode.research.import.title')}>
      <h3>{t('kubecode.research.import.title')}</h3>
      <p className="kubecode-research-muted">{t('kubecode.research.import.intro')}</p>
      {!detail.archived && (
        <form
          className="kubecode-research-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="kubecode-research-row">
            <Input
              aria-label={t('kubecode.research.import.label')}
              maxLength={200}
              placeholder={t('kubecode.research.import.labelPlaceholder')}
              value={label}
              onChange={(event) => {
                setSaved(false)
                setLabel(event.target.value)
              }}
            />
            <Select value={origin} onValueChange={(value) => setOrigin(value as ResearchImportOrigin)}>
              <SelectTrigger aria-label={t('kubecode.research.import.origin')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="markdown">{t('kubecode.research.import.originMarkdown')}</SelectItem>
                <SelectItem value="paste">{t('kubecode.research.import.originPaste')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            aria-label={t('kubecode.research.import.text')}
            placeholder={t('kubecode.research.import.textPlaceholder')}
            rows={6}
            value={content}
            onChange={(event) => {
              setSaved(false)
              setContent(event.target.value)
            }}
          />
          <p
            className={tooLarge ? 'kubecode-research-error' : 'kubecode-research-muted'}
            role={tooLarge ? 'alert' : undefined}
          >
            {tooLarge
              ? t('kubecode.research.import.tooLarge')
              : t('kubecode.research.import.size', { bytes, max: MAX_IMPORT_BYTES })}
          </p>
          {importing.error && <p className="kubecode-research-error" role="alert">{importing.error}</p>}
          {saved && <p className="kubecode-research-notice" role="status">{t('kubecode.research.import.saved')}</p>}
          <div className="kubecode-research-panel-actions">
            <Button aria-busy={importing.busy} disabled={!canImport || importing.busy} size="sm" type="submit">
              {t('kubecode.research.import.submit')}
            </Button>
          </div>
        </form>
      )}
      {imports.length === 0 ? (
        <p className="kubecode-research-muted">{t('kubecode.research.import.empty')}</p>
      ) : (
        <ul className="kubecode-research-list">
          {imports.map((item) => (
            <li key={item.id}>
              <div className="kubecode-research-row">
                <strong>{item.label}</strong>
                <span className="kubecode-research-muted">
                  {item.origin === 'markdown'
                    ? t('kubecode.research.import.originMarkdown')
                    : t('kubecode.research.import.originPaste')}
                  {' · '}
                  {item.created_at}
                </span>
                <Button
                  aria-expanded={openId === item.id}
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
                <p className="kubecode-research-notice" role="status">
                  {t('kubecode.research.import.stale', {
                    based: item.based_on_revision,
                    current: item.current_revision,
                  })}
                </p>
              )}
              {openId === item.id && (
                <ImportReview api={api} detail={detail} item={item} onChanged={onChanged} t={t} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
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
  const apply = useAction(t)

  useEffect(() => {
    let current = true
    api.getResearchImport(detail.project_id, detail.id, item.id)
      .then((value) => current && setLoaded({ id: item.id, value }))
      .catch(() => current && setLoaded({ id: item.id, failed: true }))
    return () => {
      current = false
    }
  }, [api, detail.id, detail.project_id, item.id])

  const ready = loaded && loaded.id === item.id ? loaded : null
  if (!ready) {
    return <p className="kubecode-research-muted" role="status">{t('kubecode.loadingContext')}</p>
  }
  if ('failed' in ready) {
    return <p className="kubecode-research-error" role="alert">{t('kubecode.research.import.loadFailed')}</p>
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
    // The revision the researcher is looking at: a newer approved brief makes
    // the server refuse (409) instead of overwriting it, and the selection stays.
    if (proposal.changes.length > 0) {
      await api.updateResearch(
        detail.project_id,
        detail.id,
        detail.revision,
        proposal.patch,
        undefined,
        item.id,
      )
    }
    for (const [index, decision] of proposal.decisions.entries()) {
      await api.addResearchEntry(
        detail.project_id,
        detail.id,
        'decision',
        `${decision} (${item.label})`,
        `import-${item.id.slice(0, 8)}-d${index}-${decision.length}`,
      )
    }
    setApplied(detail.revision + (proposal.changes.length > 0 ? 1 : 0))
    setSelected(new Set())
    onChanged()
  })

  return (
    <div className="kubecode-research-review" aria-label={item.label}>
      {item.stale && (
        <p className="kubecode-research-notice" role="status">
          {t('kubecode.research.import.staleWarning')}
        </p>
      )}
      <pre className="kubecode-research-import-text" tabIndex={0}>{content}</pre>
      <h4>{t('kubecode.research.import.candidates')}</h4>
      <p className="kubecode-research-muted">{t('kubecode.research.import.candidatesNote')}</p>
      {candidates.length === 0 ? (
        <p className="kubecode-research-muted">{t('kubecode.research.import.noCandidates')}</p>
      ) : (
        CANDIDATE_KIND_ORDER.map((kind) => {
          const ofKind = candidates
            .map((candidate, index) => ({ candidate, index }))
            .filter(({ candidate }) => candidate.kind === kind)
          if (ofKind.length === 0) return null
          return (
            <fieldset className="kubecode-research-carry" key={kind}>
              <legend>{t(`kubecode.research.import.kind.${kind}`)}</legend>
              {ofKind.map(({ candidate, index }) => (
                <label key={index}>
                  <input
                    checked={selected.has(index)}
                    disabled={detail.archived || kind === 'open_question'}
                    type="checkbox"
                    onChange={(event) => toggle(index, event.target.checked)}
                  />
                  <span>{candidate.text}</span>
                  <span className="kubecode-research-muted">
                    {t('kubecode.research.import.line', { line: candidate.line })}
                  </span>
                </label>
              ))}
            </fieldset>
          )
        })
      )}
      {candidates.some((candidate) => candidate.kind === 'open_question') && (
        <p className="kubecode-research-muted">{t('kubecode.research.import.openNote')}</p>
      )}
      <h4>{t('kubecode.research.import.proposal')}</h4>
      {!hasChange ? (
        <p className="kubecode-research-muted">{t('kubecode.research.import.proposalNone')}</p>
      ) : (
        <div className="kubecode-research-compare">
          {proposal.changes.map((change) => (
            <div key={change.field}>
              <strong>{t(FIELD_LABELS[change.field])}</strong>
              <div className="kubecode-research-row">
                <div>
                  <small>{t('kubecode.research.import.before')}</small>
                  <p className="whitespace-pre-line">{Array.isArray(change.before) ? change.before.join('\n') || '—' : change.before}</p>
                </div>
                <div>
                  <small>{t('kubecode.research.import.after')}</small>
                  <p className="whitespace-pre-line">{Array.isArray(change.after) ? change.after.join('\n') : change.after}</p>
                </div>
              </div>
            </div>
          ))}
          {proposal.decisions.length > 0 && (
            <div>
              <p className="kubecode-research-muted">{t('kubecode.research.import.decisionsNote')}</p>
              <ul>{proposal.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {proposal.overLimit && (
        <p className="kubecode-research-error" role="alert">{t('kubecode.research.import.overLimit')}</p>
      )}
      {apply.error && <p className="kubecode-research-error" role="alert">{apply.error}</p>}
      {applied !== null && (
        <p className="kubecode-research-notice" role="status">
          {t('kubecode.research.import.applied', { revision: applied })}
        </p>
      )}
      <div className="kubecode-research-panel-actions">
        <Button
          aria-busy={apply.busy}
          disabled={detail.archived || !hasChange || proposal.overLimit || apply.busy}
          size="sm"
          onClick={() => void applyChange()}
        >
          {t('kubecode.research.import.apply', {
            from: detail.revision,
            to: detail.revision + (proposal.changes.length > 0 ? 1 : 0),
          })}
        </Button>
      </div>
    </div>
  )
}
