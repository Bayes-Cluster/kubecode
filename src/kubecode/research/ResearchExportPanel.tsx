import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { TranslationKey, Translator } from '@/lib/i18n'

import type {
  KubecodeApi,
  ResearchDetail,
  ResearchExportPacket,
  ResearchPacketSectionId,
} from '../api'

const SECTIONS: Array<{ id: ResearchPacketSectionId; label: TranslationKey }> = [
  { id: 'brief', label: 'kubecode.research.export.section.brief' },
  { id: 'progress', label: 'kubecode.research.export.section.progress' },
  { id: 'findings', label: 'kubecode.research.export.section.findings' },
  { id: 'evidence', label: 'kubecode.research.export.section.evidence' },
  { id: 'open_questions', label: 'kubecode.research.export.section.open_questions' },
]

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

  const build = async () => {
    setState('loading')
    setCopy('idle')
    try {
      const sections = SECTIONS.filter((section) => included.has(section.id)).map((section) => section.id)
      setPacket(await api.exportResearchPacket(detail.project_id, detail.id, sections))
      setState('idle')
    } catch {
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
    <section className="kubecode-research-section" aria-label={t('kubecode.research.export.title')}>
      <h3>{t('kubecode.research.export.title')}</h3>
      <p className="kubecode-research-muted">{t('kubecode.research.export.intro')}</p>
      <fieldset className="kubecode-research-carry">
        <legend>{t('kubecode.research.export.sections')}</legend>
        {SECTIONS.map((section) => (
          <label key={section.id}>
            <input
              checked={included.has(section.id)}
              type="checkbox"
              onChange={(event) => {
                setPacket(null)
                setIncluded((current) => {
                  const next = new Set(current)
                  if (event.target.checked) next.add(section.id)
                  else next.delete(section.id)
                  return next
                })
              }}
            />
            <span>{t(section.label)}</span>
          </label>
        ))}
      </fieldset>
      <div className="kubecode-research-panel-actions">
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
        <p className="kubecode-research-error" role="alert">{t('kubecode.research.export.previewFailed')}</p>
      )}
      {packet && (
        <div>
          <h4>{t('kubecode.research.export.leaves')}</h4>
          <ul>
            {packet.contents.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="kubecode-research-muted">
            {t('kubecode.research.export.size', {
              bytes: packet.total_bytes,
              revision: packet.brief_revision,
            })}
          </p>
          {packet.truncated && (
            <p className="kubecode-research-notice" role="status">{t('kubecode.research.export.truncated')}</p>
          )}
          <Textarea
            aria-label={t('kubecode.research.export.packet')}
            readOnly
            rows={10}
            value={packet.markdown}
          />
          <div className="kubecode-research-panel-actions">
            <Button size="sm" onClick={() => void copyPacket()}>
              {t('kubecode.research.export.copy')}
            </Button>
          </div>
          {copy === 'copied' && <p className="kubecode-research-notice" role="status">{t('kubecode.research.export.copied')}</p>}
          {copy === 'failed' && <p className="kubecode-research-error" role="alert">{t('kubecode.research.export.copyFailed')}</p>}
        </div>
      )}
    </section>
  )
}
