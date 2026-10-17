import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import { ApiError } from '../api'
import type { KubecodeApi, ResearchBrief, ResearchBriefPatch, ResearchDetail } from '../api'
import { useAction } from './useAction'

type Draft = {
  title: string
  question: string
  motivation: string
  hypotheses: string
  constraints: string
  evaluation_criteria: string
}

const LIST_FIELDS = ['hypotheses', 'constraints', 'evaluation_criteria'] as const

function toDraft(brief: ResearchBrief): Draft {
  return {
    title: brief.title,
    question: brief.question,
    motivation: brief.motivation,
    hypotheses: brief.hypotheses.join('\n'),
    constraints: brief.constraints.join('\n'),
    evaluation_criteria: brief.evaluation_criteria.join('\n'),
  }
}

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Only the fields that differ from the brief the edit started from. */
function toPatch(draft: Draft, brief: ResearchBrief): ResearchBriefPatch {
  const patch: ResearchBriefPatch = {}
  if (draft.title.trim() !== brief.title) patch.title = draft.title.trim()
  if (draft.question.trim() !== brief.question) patch.question = draft.question.trim()
  if (draft.motivation.trim() !== brief.motivation) patch.motivation = draft.motivation.trim()
  for (const field of LIST_FIELDS) {
    const next = lines(draft[field])
    if (next.join('\n') !== brief[field].join('\n')) patch[field] = next
  }
  return patch
}

export function ResearchBriefPanel({
  api,
  detail,
  onChanged,
  t,
}: {
  api: KubecodeApi
  detail: ResearchDetail
  onChanged: () => void
  t: Translator
}) {
  // The revision the edit began from; saving sends it, so a brief that moved
  // underneath the researcher is a conflict rather than an overwrite.
  const [editing, setEditing] = useState<{ draft: Draft; base: ResearchBrief; revision: number } | null>(null)
  const [conflict, setConflict] = useState(false)
  const action = useAction(t, (cause) => {
    if (cause instanceof ApiError && cause.code === 'research_revision_conflict') setConflict(true)
  })
  const { brief } = detail

  if (!editing) {
    return (
      <div className="kubecode-research-panel">
        <div className="kubecode-research-panel-actions">
          <span className="kubecode-research-muted">
            {t('kubecode.research.revision', { revision: detail.revision })}
          </span>
          <Button
            disabled={detail.archived}
            size="sm"
            variant="outline"
            onClick={() => {
              setConflict(false)
              action.clearError()
              setEditing({ draft: toDraft(brief), base: brief, revision: detail.revision })
            }}
          >
            {t('kubecode.research.editBrief')}
          </Button>
        </div>
        <BriefField label={t('kubecode.research.field.question')} text={brief.question} />
        <BriefField label={t('kubecode.research.field.motivation')} text={brief.motivation} />
        <BriefList label={t('kubecode.research.field.hypotheses')} items={brief.hypotheses} />
        <BriefList label={t('kubecode.research.field.constraints')} items={brief.constraints} />
        <BriefList label={t('kubecode.research.field.criteria')} items={brief.evaluation_criteria} />
      </div>
    )
  }

  const patch = toPatch(editing.draft, editing.base)
  const unchanged = Object.keys(patch).length === 0
  const valid = editing.draft.title.trim() !== '' && editing.draft.question.trim() !== ''
  const set = (field: keyof Draft, value: string) => setEditing({
    ...editing,
    draft: { ...editing.draft, [field]: value },
  })
  const save = async () => {
    const saved = await action.run(() => api.updateResearch(
      detail.project_id,
      detail.id,
      editing.revision,
      patch,
    ))
    if (saved) {
      setEditing(null)
      onChanged()
    }
  }

  return (
    <form
      className="kubecode-research-panel kubecode-research-form"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label>
        <span>{t('kubecode.research.field.title')}</span>
        <Input value={editing.draft.title} maxLength={200} onChange={(event) => set('title', event.target.value)} />
      </label>
      <label>
        <span>{t('kubecode.research.field.question')}</span>
        <Textarea rows={4} value={editing.draft.question} onChange={(event) => set('question', event.target.value)} />
      </label>
      <label>
        <span>{t('kubecode.research.field.motivation')}</span>
        <Textarea rows={3} value={editing.draft.motivation} onChange={(event) => set('motivation', event.target.value)} />
      </label>
      {LIST_FIELDS.map((field) => (
        <label key={field}>
          <span>{t(listLabelKey(field))}</span>
          <Textarea rows={3} value={editing.draft[field]} onChange={(event) => set(field, event.target.value)} />
        </label>
      ))}
      <p className="kubecode-research-muted">{t('kubecode.research.listHint')}</p>
      {conflict ? (
        <div className="kubecode-research-error" role="alert">
          <p>{t('kubecode.research.error.revisionConflict')}</p>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              setEditing(null)
              setConflict(false)
              onChanged()
            }}
          >
            {t('kubecode.research.discardAndReload')}
          </Button>
        </div>
      ) : action.error ? (
        <p className="kubecode-research-error" role="alert">{action.error}</p>
      ) : null}
      <div className="kubecode-research-panel-actions">
        <Button type="button" variant="ghost" disabled={action.busy} onClick={() => setEditing(null)}>
          {t('kubecode.cancel')}
        </Button>
        <Button aria-busy={action.busy} disabled={!valid || unchanged || action.busy || conflict} type="submit">
          {t('kubecode.research.saveBrief')}
        </Button>
      </div>
    </form>
  )
}

function listLabelKey(field: (typeof LIST_FIELDS)[number]) {
  if (field === 'hypotheses') return 'kubecode.research.field.hypotheses' as const
  if (field === 'constraints') return 'kubecode.research.field.constraints' as const
  return 'kubecode.research.field.criteria' as const
}

function BriefField({ label, text }: { label: string; text: string }) {
  if (!text) return null
  return (
    <section className="kubecode-research-field">
      <h4>{label}</h4>
      <p>{text}</p>
    </section>
  )
}

function BriefList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <section className="kubecode-research-field">
      <h4>{label}</h4>
      <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
    </section>
  )
}
