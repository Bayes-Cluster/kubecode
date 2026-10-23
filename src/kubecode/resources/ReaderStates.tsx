import type { ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'

/**
 * The states every Workspace reader shares (search, record preview,
 * evidence): official Spinner, Empty and Alert, so Resources, Add context and
 * a Task's evidence say loading, nothing, changed and failed the same way.
 * Only the roles are chosen here; the components own the look.
 */
export function ReaderLoading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status">
      <Spinner aria-hidden="true" aria-label={undefined} role={undefined} />
      <span>{children}</span>
    </div>
  )
}

/** Nothing to show; never an error. */
export function ReaderEmpty({ children }: { children: ReactNode }) {
  return (
    <Empty className="p-4 md:p-6" role="status">
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
    <Alert className="py-2" role={role} variant={failed ? 'destructive' : 'default'}>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>{children}</span>
        {action}
      </AlertDescription>
    </Alert>
  )
}
