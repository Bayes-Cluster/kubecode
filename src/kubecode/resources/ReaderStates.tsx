import type { ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'

/**
 * The states every Workspace reader shares (search, record preview,
 * evidence): the official Empty (compact, with the Spinner as its media)
 * and Alert, so Resources, Add context and a Task's evidence say loading,
 * nothing, changed and failed the same way. Only the roles are chosen here;
 * the components own the look (ADR 0256).
 */
export function ReaderLoading({ children }: { children: ReactNode }) {
  return (
    <Empty role="status" size="compact">
      <EmptyHeader>
        <EmptyMedia>
          <Spinner aria-hidden="true" role="presentation" />
        </EmptyMedia>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Nothing to show; never an error. */
export function ReaderEmpty({ children }: { children: ReactNode }) {
  return (
    <Empty role="status" size="compact">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/**
 * A notice with an optional action. `failed` is a destructive alert the
 * screen reader hears at once; otherwise a polite status (stale results, a
 * newer version, a cut-short scope).
 */
export function ReaderNotice({
  action,
  children,
  failed = false,
  live = true,
}: {
  children: ReactNode
  action?: ReactNode
  failed?: boolean
  /** False for a standing note that is neither a status nor an alert. */
  live?: boolean
}) {
  const role = failed ? 'alert' : live ? 'status' : undefined
  return (
    <Alert role={role} variant={failed ? 'destructive' : 'default'}>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>{children}</span>
        {action}
      </AlertDescription>
    </Alert>
  )
}
