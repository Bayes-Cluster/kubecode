import { useId, useRef, useState } from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type {
  KubecodeApi,
  ResearchDetail,
  ResearchExportPacket,
  ResearchPacketSectionId,
} from '../api'
import { ResearchSection } from './ResearchLayout'

const SECTIONS: Array<{ id: ResearchPacketSectionId; label: TranslationKey }> = [
  { id: 'brief', label: 'kubecode.research.export.section.brief' },
  { id: 'progress', label: 'kubecode.research.export.section.progress' },
  { id: 'findings', label: 'kubecode.research.export.section.findings' },
  { id: 'evidence', label: 'kubecode.research.export.section.evidence' },
  { id: 'open_questions', label: 'kubecode.research.export.section.open_questions' },
]

const CONTENTS: Record<ResearchPacketSectionId, TranslationKey> = {
  brief: 'kubecode.research.export.contents.brief',
  progress: 'kubecode.research.export.contents.progress',
  findings: 'kubecode.research.export.contents.findings',
  evidence: 'kubecode.research.export.contents.evidence',
  open_questions: 'kubecode.research.export.contents.open_questions',
}

/**
 * A bounded packet for a discussion held elsewhere. The researcher chooses
 * what to include and reads exactly what would leave the workspace; nothing is
 * sent anywhere, and copying is their own explicit action.
 */
export function ResearchExportPanel({
  api,
  detail,
  t,
}: {
  api: KubecodeApi
  detail: ResearchDetail
  t: Translator
}) {
  const [included, setIncluded] = useState<Set<ResearchPacketSectionId>>(
    new Set(SECTIONS.map((section) => section.id)),
  )
  const [packet, setPacket] = useState<ResearchExportPacket | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  // Only the newest build may land: a slow response for other checkboxes is dropped.
  const ticket = useRef(0)
  const fieldId = useId()

  const build = async () => {
    const mine = ++ticket.current
    setState('loading')
    setCopy('idle')
    try {
      const sections = SECTIONS.filter((section) => included.has(section.id)).map((section) => section.id)
      const built = await api.exportResearchPacket(detail.project_id, detail.id, sections)
      if (mine !== ticket.current) return
      setPacket(built)
      setState('idle')
    } catch {
      if (mine !== ticket.current) return
      setPacket(null)
      setState('failed')
    }
  }

  const copyPacket = async () => {
    if (!packet) return
    try {
      await navigator.clipboard.writeText(packet.markdown)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <ResearchSection label={t('kubecode.research.export.title')} named>
      <p className="m-0 text-sm text-muted-foreground">{t('kubecode.research.export.intro')}</p>
      <FieldSet className="rounded-md border p-3">
        <FieldLegend variant="label">{t('kubecode.research.export.sections')}</FieldLegend>
        <FieldGroup className="gap-2">
          {SECTIONS.map((section) => (
            <Field key={section.id} orientation="horizontal">
              <Checkbox
                checked={included.has(section.id)}
                id={`${fieldId}-${section.id}`}
                onCheckedChange={(checked) => {
                  ticket.current += 1
                  setPacket(null)
                  setState('idle')
                  setIncluded((current) => {
                    const next = new Set(current)
                    if (checked === true) next.add(section.id)
                    else next.delete(section.id)
                    return next
                  })
                }}
              />
              <FieldLabel className="font-normal" htmlFor={`${fieldId}-${section.id}`}>{t(section.label)}</FieldLabel>
            </Field>
          ))}
        </FieldGroup>
      </FieldSet>
      <div className="flex justify-end">
        <Button
          aria-busy={state === 'loading'}
          disabled={included.size === 0 || state === 'loading'}
          size="sm"
          variant="outline"
          onClick={() => void build()}
        >
          {t('kubecode.research.export.preview')}
        </Button>
      </div>
      {state === 'failed' && (
        <Alert variant="destructive"><AlertDescription>{t('kubecode.research.export.previewFailed')}</AlertDescription></Alert>
      )}
      {packet && packet.brief_revision !== detail.revision && (
        <Alert role="status"><TriangleAlert /><AlertDescription>{t('kubecode.research.export.outdated')}</AlertDescription></Alert>
      )}
      {packet && packet.brief_revision === detail.revision && (
        <div className="flex flex-col gap-2">
          <ResearchSection label={t('kubecode.research.export.leaves')} level={4}>
            <ul className="m-0 list-disc pl-5 text-sm">
              {SECTIONS.filter((section) => (
                packet.sections.find((item) => item.id === section.id)?.included
              )).map((section) => <li key={section.id}>{t(CONTENTS[section.id])}</li>)}
              <li>{t('kubecode.research.export.contents.never')}</li>
            </ul>
          </ResearchSection>
          <p className="m-0 text-xs text-muted-foreground">
            {t('kubecode.research.export.size', {
              bytes: packet.total_bytes,
              revision: packet.brief_revision,
            })}
          </p>
          {packet.truncated && (
            <Alert role="status"><TriangleAlert /><AlertDescription>{t('kubecode.research.export.truncated')}</AlertDescription></Alert>
          )}
          <Textarea
            aria-label={t('kubecode.research.export.packet')}
            readOnly
            rows={10}
            value={packet.markdown}
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void copyPacket()}>
              {t('kubecode.research.export.copy')}
            </Button>
          </div>
          {copy === 'copied' && <Alert role="status"><CircleCheck /><AlertDescription>{t('kubecode.research.export.copied')}</AlertDescription></Alert>}
          {copy === 'failed' && <Alert variant="destructive"><AlertDescription>{t('kubecode.research.export.copyFailed')}</AlertDescription></Alert>}
        </div>
      )}
    </ResearchSection>
  )
}
