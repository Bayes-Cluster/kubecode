import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Layout only for the research views (ADR 0247 §CSS ownership): a panel column
 * and a titled section. Controls, feedback and lists inside them are official
 * components; these two own no appearance beyond spacing and the section label.
 */
export function ResearchPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex max-w-[820px] flex-col gap-4 pt-2', className)}>{children}</div>
}

export function ResearchSection({
  actions,
  children,
  className,
  label,
  level = 3,
}: {
  actions?: ReactNode
  children: ReactNode
  className?: string
  label: ReactNode
  level?: 3 | 4
}) {
  const Heading = level === 3 ? 'h3' : 'h4'
  return (
    <section className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</Heading>
        {actions}
      </div>
      {children}
    </section>
  )
}
