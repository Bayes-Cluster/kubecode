import { X } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { GitDiffUnavailableReason } from './api'
import type { GitDiffState, GitDiffTarget } from './useGitDiff'

type GitDiffViewProps = {
  state: GitDiffState
  onClose: () => void
  onRetry: (target: GitDiffTarget) => void
  t: Translator
}

export function GitDiffView({ state, onClose, onRetry, t }: GitDiffViewProps) {
  if (state.kind === 'idle') return null
  const target = state.target

  return (
    <>
      <div className="kubecode-editor-toolbar">
        <span title={target.path}>{target.path}</span>
        <Button aria-label={t('kubecode.closeDiff')} size="icon-xs" variant="ghost" onClick={onClose}><X /></Button>
      </div>
      {state.kind === 'loading' && (
        <div className="kubecode-diff-message" role="status">{t('kubecode.gitDiffLoading')}</div>
      )}
      {state.kind === 'ready' && state.content && (
        <pre>{state.content}</pre>
      )}
      {state.kind === 'ready' && !state.content && (
        <div className="kubecode-diff-message" role="status">
          {gitDiffUnavailableMessage(state.unavailableReason, t)}
        </div>
      )}
      {state.kind === 'failed' && (
        <div className="kubecode-diff-message" role="alert">
          <strong>{t('kubecode.gitDiffFailed')}</strong>
          {(() => {
            const detail = errorText(state.error)
            return detail ? <small>{detail}</small> : null
          })()}
          <Button size="sm" variant="outline" onClick={() => onRetry(target)}>
            {t('kubecode.retry')}
          </Button>
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
