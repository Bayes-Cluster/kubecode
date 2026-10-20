/**
 * Adapted from AI Elements `loader`
 * (https://ui.shadcn.com/docs/ai-elements/components/loader,
 * registry https://registry.ai-sdk.dev/loader.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): the spinner is announced with a caller label (a
 * status, not an image titled "Loader"); the clip-path id is unique per
 * instance; it stops spinning under reduced motion.
 */
import { useId, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

const SPOKES: Array<[string, number]> = [
  ['M8 0V4', 1],
  ['M8 16V12', 0.5],
  ['M3.29773 1.52783L5.64887 4.7639', 0.9],
  ['M12.7023 1.52783L10.3511 4.7639', 0.1],
  ['M12.7023 14.472L10.3511 11.236', 0.4],
  ['M3.29773 14.472L5.64887 11.236', 0.6],
  ['M15.6085 5.52783L11.8043 6.7639', 0.2],
  ['M0.391602 10.472L4.19583 9.23598', 0.7],
  ['M15.6085 10.4722L11.8043 9.2361', 0.3],
  ['M0.391602 5.52783L4.19583 6.7639', 0.8],
]

export type LoaderProps = HTMLAttributes<HTMLSpanElement> & { size?: number; label: string }

export function Loader({ className, label, size = 16, ...props }: LoaderProps) {
  const clip = useId()
  return (
    <span className={cn('kubecode-ai-loader', className)} role="status" {...props}>
      <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
        <g clipPath={`url(#${CSS.escape(clip)})`}>
          {SPOKES.map(([d, opacity]) => <path d={d} key={d} opacity={opacity} stroke="currentColor" strokeWidth="1.5" />)}
        </g>
        <defs>
          <clipPath id={clip}><rect fill="white" height="16" width="16" /></clipPath>
        </defs>
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  )
}
