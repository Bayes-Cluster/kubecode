import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'

/** The main area while a place opens: one status, read once. */
export function RouteOpening({ label }: { label: string }) {
  return (
    <Empty className="flex-1" role="status">
      <EmptyHeader>
        <EmptyMedia>
          <Spinner aria-hidden="true" role="presentation" />
        </EmptyMedia>
        <EmptyTitle>{label}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  )
}
