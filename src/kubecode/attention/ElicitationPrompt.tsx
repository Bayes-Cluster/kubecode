import { useState } from 'react'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { DecisionButton } from '@/components/workspace/DecisionButton'
import type { Translator } from '@/lib/i18n'

import type { ElicitationAnswer, PendingElicitation } from '../session/conversationReducer'
import { elicitationComplete } from '../session/sessionModel'
import { isGone } from './attentionContext'

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
  return (
    <div
      aria-label={elicitation.message ? `${title}: ${elicitation.message}` : title}
      className="kubecode-elicitation-dock"
      data-focus-key={`input:${elicitation.requestId}`}
      role="group"
      tabIndex={-1}
    >
      <div className="kubecode-elicitation-heading">
        <strong>{title}</strong>
        <span>{elicitation.message}</span>
      </div>
      <div className="kubecode-elicitation-fields">
        {elicitation.properties.map((property) => (
          <label key={property.id} className="kubecode-elicitation-field">
            <span>{property.label}{property.required ? ' *' : ''}</span>
            {property.description && <small>{property.description}</small>}
            {property.type === 'boolean' ? (
              <Switch
                aria-label={property.label}
                checked={Boolean(answers[property.id])}
                onCheckedChange={(value) => onAnswerChange(property.id, value)}
              />
            ) : property.options.length > 0 ? (
              <Select
                value={String(answers[property.id] ?? '')}
                onValueChange={(value) => onAnswerChange(property.id, value)}
              >
                <SelectTrigger aria-label={property.label}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {property.options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                aria-label={property.label}
                type={property.type === 'string' ? 'text' : 'number'}
                value={String(answers[property.id] ?? '')}
                onChange={(event) => onAnswerChange(property.id, event.target.value)}
              />
            )}
          </label>
        ))}
      </div>
      <div className="kubecode-elicitation-actions">
        <DecisionButton busy={busy === 'decline' || resolving} variant="secondary" onDecide={() => void resolve(false)}>
          {t('kubecode.decline')}
        </DecisionButton>
        <DecisionButton
          busy={busy === 'submit' || resolving}
          disabledReason={complete ? undefined : t('kubecode.attention.answerRequired')}
          variant="primary"
          onDecide={() => void resolve(true)}
        >
          {t('kubecode.submitAnswers')}
        </DecisionButton>
      </div>
      {resolving && <p className="kubecode-research-muted" role="status">{t('kubecode.attention.resolving')}</p>}
      {outcome === 'failed' && <p className="kubecode-research-error" role="alert">{t('kubecode.attention.resolveFailed')}</p>}
      {outcome === 'gone' && <p className="kubecode-research-muted" role="status">{t('kubecode.attention.answeredElsewhere')}</p>}
    </div>
  )
}
