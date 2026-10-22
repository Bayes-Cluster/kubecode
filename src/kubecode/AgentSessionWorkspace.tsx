import { lazy, Suspense, type ComponentProps } from 'react'

import type { AgentSessionWorkspace as EagerAgentSessionWorkspace } from './session/SessionWorkspace'

export type { SessionPlanEntry } from './session/SessionPlanSummary'

// The Session view carries the official AI Elements with streamdown, shiki
// and motion; it loads on first open so the Workspace entry stays lean
// (ADRs 0241 §9 and 0245).
const LazyAgentSessionWorkspace = lazy(async () => ({
  default: (await import('./session/SessionWorkspace')).AgentSessionWorkspace,
}))

export function AgentSessionWorkspace(props: ComponentProps<typeof EagerAgentSessionWorkspace>) {
  return (
    <Suspense fallback={null}>
      <LazyAgentSessionWorkspace {...props} />
    </Suspense>
  )
}
