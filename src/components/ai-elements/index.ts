// Product call sites import the Workspace adaptations (ADR 0233) through this
// barrel until slices S1–S4 move each surface onto the official AI Elements
// that sit beside it in this folder (ADR 0241). Names are unchanged.
export * from './workspace/chain-of-thought'
export * from './workspace/confirmation'
export * from './workspace/conversation'
export * from './workspace/inline-citation'
export * from './workspace/loader'
export * from './workspace/message'
export * from './workspace/prompt-input'
export * from './workspace/queue'
export * from './workspace/shimmer'
export * from './workspace/sources'
export * from './workspace/suggestion'
export * from './workspace/task'
export * from './workspace/tool'
