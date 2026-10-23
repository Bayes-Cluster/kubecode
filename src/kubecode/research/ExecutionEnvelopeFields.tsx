import { useId } from 'react'

import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
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
  const id = useId()
  const field = (
    key: 'maxLaunches' | 'maxConcurrent' | 'maxRuntimeMinutes' | 'maxNoProgress',
    label: string,
    name: NonNullable<typeof invalid>,
  ) => (
    <Field data-invalid={invalid === name || undefined} key={key}>
      <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
      <Input
        aria-invalid={invalid === name}
        id={`${id}-${key}`}
        inputMode="numeric"
        value={draft[key]}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
      />
    </Field>
  )
  return (
    <FieldSet
      className="min-w-0 rounded-md border p-3"
      // Enter in a limit field must not submit a surrounding form (starting a round).
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
      }}
    >
      <FieldLegend variant="label">{t('kubecode.research.exec.envelope')}</FieldLegend>
      <FieldDescription>{t('kubecode.research.exec.envelopeHint')}</FieldDescription>
      <FieldGroup className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        {field('maxLaunches', t('kubecode.research.exec.maxLaunches'), 'launches')}
        {field('maxConcurrent', t('kubecode.research.exec.maxConcurrent'), 'concurrent')}
        {field('maxRuntimeMinutes', t('kubecode.research.exec.maxRuntime'), 'runtime')}
        {field('maxNoProgress', t('kubecode.research.exec.maxNoProgress'), 'noProgress')}
        <Field data-invalid={invalid === 'deadline' || undefined}>
          <FieldLabel htmlFor={`${id}-deadline`}>{t('kubecode.research.exec.deadlineHours')}</FieldLabel>
          <Input
            aria-invalid={invalid === 'deadline'}
            id={`${id}-deadline`}
            inputMode="decimal"
            value={draft.deadlineHours}
            onChange={(event) => onChange({ ...draft, deadlineHours: event.target.value, deadlineEdited: true })}
          />
        </Field>
      </FieldGroup>
      <Field data-invalid={invalid === 'commands' || undefined}>
        <FieldLabel htmlFor={`${id}-commands`}>{t('kubecode.research.exec.allowedCommands')}</FieldLabel>
        <Textarea
          aria-invalid={invalid === 'commands'}
          id={`${id}-commands`}
          rows={3}
          value={draft.commands}
          placeholder={t('kubecode.research.exec.commandsPlaceholder')}
          onChange={(event) => onChange({ ...draft, commands: event.target.value })}
        />
        <FieldDescription>{t('kubecode.research.exec.commandsHint')}</FieldDescription>
      </Field>
      {invalid && <FieldError role="alert">{t('kubecode.research.exec.invalid')}</FieldError>}
    </FieldSet>
  )
}
