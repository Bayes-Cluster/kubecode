import { Alert, AlertDescription } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'

/**
 * What happened to an answer, shared by every prompt (#259): recorded and
 * waiting (a polite status), refused (an official destructive Alert, heard at
 * once), or no longer waiting because it was answered elsewhere.
 */
export function PromptOutcome({ outcome, resolving, t }: {
  outcome: 'failed' | 'gone' | null
  resolving: boolean
  t: Translator
}) {
  return (
    <>
      {resolving && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner aria-hidden aria-label={undefined} className="motion-reduce:animate-none" role={undefined} />
          {t('kubecode.attention.resolving')}
        </p>
      )}
      {outcome === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>{t('kubecode.attention.resolveFailed')}</AlertDescription>
        </Alert>
      )}
      {outcome === 'gone' && <p className="text-sm text-muted-foreground" role="status">{t('kubecode.attention.answeredElsewhere')}</p>}
    </>
  )
}
