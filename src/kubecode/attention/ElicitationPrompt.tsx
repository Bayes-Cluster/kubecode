import { useId, useState } from 'react'

import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import type { Translator } from '@/lib/i18n'

import type { ElicitationAnswer, PendingElicitation } from '../session/conversationReducer'
import { elicitationComplete } from '../session/sessionModel'
import { isGone } from './attentionContext'
import { PromptOutcome } from './PromptOutcome'

export type ElicitationPromptProps = {
  elicitation: PendingElicitation
  answers: Record<string, ElicitationAnswer>
  onAnswerChange: (id: string, value: ElicitationAnswer) => void
  /** `true` submits the answers, `false` declines. */
  onResolve: (accepted: boolean) => Promise<void> | void
  onGone?: () => void
  /** Who asks; "Answer Agent question" when absent. */
  heading?: string
  /** Answered, and waiting for the server to drop it: nothing answers it again. */
  resolving?: boolean
  t: Translator
}

/** An agent's request for input, answered in place with the fields it asks for (ADR 0232). */
export function ElicitationPrompt({ answers, elicitation, heading, onAnswerChange, onGone, onResolve, resolving = false, t }: ElicitationPromptProps) {
  const [busy, setBusy] = useState<'submit' | 'decline' | null>(null)
  const [outcome, setOutcome] = useState<'failed' | 'gone' | null>(null)
  const title = heading ?? t('kubecode.answerAgentQuestion')
  const resolve = async (accepted: boolean) => {
    if (busy || resolving) return
    setBusy(accepted ? 'submit' : 'decline')
    setOutcome(null)
    try {
      await onResolve(accepted)
    } catch (cause) {
      if (isGone(cause)) {
        setOutcome('gone')
        onGone?.()
      } else {
        setOutcome('failed')
      }
    } finally {
      setBusy(null)
    }
  }
  const complete = elicitationComplete(elicitation, answers)
  const declining = busy === 'decline' || resolving
  const submitting = busy === 'submit' || resolving
  // Why the answers cannot be sent yet, in words beside the decision.
  const incomplete = complete ? undefined : t('kubecode.attention.answerRequired')
  const incompleteId = useId()
  return (
    // The official Confirmation with a Field per answer (ADR 0242); a named group the dock can focus.
    <Confirmation
      approval={{ id: elicitation.requestId }}
      aria-label={elicitation.message ? `${title}: ${elicitation.message}` : title}
      className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      data-focus-key={`input:${elicitation.requestId}`}
      role="group"
      state="approval-requested"
      tabIndex={-1}
    >
      <ConfirmationTitle className="flex flex-col gap-1">
        <strong className="text-foreground [overflow-wrap:anywhere]">{title}</strong>
        {elicitation.message && <span className="[overflow-wrap:anywhere]">{elicitation.message}</span>}
      </ConfirmationTitle>
      <ConfirmationRequest>
        <FieldGroup className="gap-4">
          {elicitation.properties.map((property) => {
            const id = `elicitation-${elicitation.requestId}-${property.id}`
            return (
              <Field key={property.id} orientation={property.type === 'boolean' ? 'horizontal' : 'vertical'}>
                <FieldLabel htmlFor={id}>{property.label}{property.required ? ' *' : ''}</FieldLabel>
                {property.description && <FieldDescription>{property.description}</FieldDescription>}
                {property.type === 'boolean' ? (
                  <Switch
                    aria-label={property.label}
                    checked={Boolean(answers[property.id])}
                    id={id}
                    onCheckedChange={(value) => onAnswerChange(property.id, value)}
                  />
                ) : property.options.length > 0 ? (
                  <Select
                    value={String(answers[property.id] ?? '')}
                    onValueChange={(value) => onAnswerChange(property.id, value)}
                  >
                    <SelectTrigger aria-label={property.label} id={id}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {property.options.map((option) => (
                          <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={property.label}
                    id={id}
                    type={property.type === 'string' ? 'text' : 'number'}
                    value={String(answers[property.id] ?? '')}
                    onChange={(event) => onAnswerChange(property.id, event.target.value)}
                  />
                )}
              </Field>
            )
          })}
        </FieldGroup>
      </ConfirmationRequest>
      <ConfirmationActions className="flex-wrap justify-start self-stretch">
        <ConfirmationAction
          aria-busy={declining || undefined}
          aria-disabled={declining || undefined}
          size="wrap"
          variant="outline"
          onClick={declining ? undefined : () => void resolve(false)}
        >
          {declining && <Spinner aria-hidden="true" data-icon="inline-start" />}
          {t('kubecode.decline')}
        </ConfirmationAction>
        <ConfirmationAction
          aria-busy={submitting || undefined}
          aria-describedby={incomplete ? incompleteId : undefined}
          aria-disabled={submitting || undefined}
          disabled={Boolean(incomplete) && !submitting}
          size="wrap"
          onClick={submitting ? undefined : () => void resolve(true)}
        >
          {submitting && <Spinner aria-hidden="true" data-icon="inline-start" />}
          {t('kubecode.submitAnswers')}
        </ConfirmationAction>
        {incomplete && <FieldDescription className="basis-full" id={incompleteId}>{incomplete}</FieldDescription>}
      </ConfirmationActions>
      <PromptOutcome outcome={outcome} resolving={resolving} t={t} />
    </Confirmation>
  )
}
