import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type { EnvelopeDraft, EnvelopeResult } from './executionEnvelope'

/**
 * The execution envelope's inputs. The envelope is the researcher's own
 * authorization for server-launched processes; these limits are enforced by
 * the Runtime and are separate from Agent concurrency settings.
 */
export function ExecutionEnvelopeFields({
  draft,
  invalid,
  onChange,
  t,
}: {
  draft: EnvelopeDraft
  invalid: Extract<EnvelopeResult, { ok: false }>['field'] | null
  onChange: (draft: EnvelopeDraft) => void
  t: Translator
}) {
  const field = (
    key: 'maxLaunches' | 'maxConcurrent' | 'maxRuntimeMinutes' | 'maxNoProgress',
    label: string,
    name: NonNullable<typeof invalid>,
  ) => (
    <label key={key}>
      <span>{label}</span>
      <Input
        aria-invalid={invalid === name}
        inputMode="numeric"
        value={draft[key]}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
      />
    </label>
  )
  return (
    <fieldset
      className="kubecode-research-envelope"
      // Enter in a limit field must not submit a surrounding form (starting a round).
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
      }}
    >
      <legend>{t('kubecode.research.exec.envelope')}</legend>
      <p className="kubecode-research-muted">{t('kubecode.research.exec.envelopeHint')}</p>
      <div className="kubecode-research-envelope-grid">
        {field('maxLaunches', t('kubecode.research.exec.maxLaunches'), 'launches')}
        {field('maxConcurrent', t('kubecode.research.exec.maxConcurrent'), 'concurrent')}
        {field('maxRuntimeMinutes', t('kubecode.research.exec.maxRuntime'), 'runtime')}
        {field('maxNoProgress', t('kubecode.research.exec.maxNoProgress'), 'noProgress')}
        <label>
          <span>{t('kubecode.research.exec.deadlineHours')}</span>
          <Input
            aria-invalid={invalid === 'deadline'}
            inputMode="decimal"
            value={draft.deadlineHours}
            onChange={(event) => onChange({ ...draft, deadlineHours: event.target.value, deadlineEdited: true })}
          />
        </label>
      </div>
      <label>
        <span>{t('kubecode.research.exec.allowedCommands')}</span>
        <Textarea
          aria-invalid={invalid === 'commands'}
          rows={3}
          value={draft.commands}
          placeholder={t('kubecode.research.exec.commandsPlaceholder')}
          onChange={(event) => onChange({ ...draft, commands: event.target.value })}
        />
      </label>
      <p className="kubecode-research-muted">{t('kubecode.research.exec.commandsHint')}</p>
      {invalid && (
        <p className="kubecode-research-error" role="alert">{t('kubecode.research.exec.invalid')}</p>
      )}
    </fieldset>
  )
}
