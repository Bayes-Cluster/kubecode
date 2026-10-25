import { CircleAlert, X } from 'lucide-react'

import { IconButton } from '@/components/workspace/IconButton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import type { Translator } from '@/lib/i18n'

import type { GitDiffUnavailableReason } from './api'
import type { GitDiffState, GitDiffTarget } from './useGitDiff'
import { MaterialFileIcon } from './icons/material/materialIcons'
import { resolveFileIcon } from './icons/resolveFileIcon'

type GitDiffViewProps = {
  state: GitDiffState
  onClose: () => void
  onRetry: (target: GitDiffTarget) => void
  t: Translator
}

/**
 * One Git diff: its loading, unavailable and failed states are official
 * Empty/Spinner/Alert. The diff text itself stays a plain `pre`, because the
 * server already bounds its size and a highlighter would re-tokenize it whole.
 */
export function GitDiffView({ state, onClose, onRetry, t }: GitDiffViewProps) {
  if (state.kind === 'idle') return null
  const target = state.target

  return (
    <>
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" title={target.path}>
          <MaterialFileIcon id={resolveFileIcon(target.path)} />
          <span className="truncate">{target.path}</span>
        </span>
        <IconButton icon={<X />} label={t('kubecode.closeDiff')} onClick={onClose} />
      </div>
      {state.kind === 'loading' && (
        <Empty role="status" size="compact">
          <EmptyHeader>
            <EmptyMedia><Spinner /></EmptyMedia>
            <EmptyDescription>{t('kubecode.gitDiffLoading')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {state.kind === 'ready' && state.content && (
        <pre className="kubecode-diff-text">{state.content}</pre>
      )}
      {state.kind === 'ready' && !state.content && (
        <Empty role="status" size="compact">
          <EmptyHeader>
            <EmptyDescription>
              {gitDiffUnavailableMessage(state.unavailableReason, t)}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {state.kind === 'failed' && (
        <div className="p-3">
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>{t('kubecode.gitDiffFailed')}</AlertTitle>
            <AlertDescription className="[overflow-wrap:anywhere]">
              {errorText(state.error)}
              <Button className="mt-1" size="sm" variant="outline" onClick={() => onRetry(target)}>
                {t('kubecode.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )}
    </>
  )
}

function gitDiffUnavailableMessage(
  reason: GitDiffUnavailableReason | null,
  t: Translator,
): string {
  if (reason === 'binary') return t('kubecode.gitDiffBinary')
  if (reason === 'oversized') return t('kubecode.gitDiffTooLarge')
  if (reason === 'unsupported') return t('kubecode.gitDiffUnavailable')
  return t('kubecode.emptyDiff')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : ''
}
