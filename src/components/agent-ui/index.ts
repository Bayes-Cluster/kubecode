/**
 * ADR 0257: the owned presentation layer. This barrel is the only import
 * surface for consumers — nothing outside `src/components/agent-ui` imports a
 * deep path. Every component here is pure presentation: state and copy in,
 * DOM out; feature modules pass localized strings and real domain state.
 */
import './tokens.css'

export { BlurSwap, type BlurSwapProps } from './blur-swap'
export { FLIP_DURATION, FLIP_EASING, playFlip, readRect, useFlipGroup, type FlipOptions, type FlipRect } from './flip'
export { ShimmerBlock, ShimmerText, type ShimmerBlockProps, type ShimmerTextProps } from './shimmer'
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from './segmented-control'
export { ThinkingLoader, type ThinkingLoaderProps } from './thinking-loader'
export { Ticker, type TickerProps } from './ticker'
export { ToasterHost } from './toaster'
