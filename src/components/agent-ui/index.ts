/**
 * ADR 0257: the owned presentation layer. This barrel is the only import
 * surface for consumers — nothing outside `src/components/agent-ui` imports a
 * deep path. Every component here is pure presentation: state and copy in,
 * DOM out; feature modules pass localized strings and real domain state.
 */
import './tokens.css'

export { BlurSwap, type BlurSwapProps } from './blur-swap'
export {
  AgxBoard,
  AgxBoardCardBody,
  AgxBoardCard,
  AgxBoardChips,
  AgxBoardChip,
  AgxBoardColumn,
  AgxBoardColumns,
  AgxBoardDrop,
} from './board'
export {
  AgxComposer,
  AgxComposerChip,
  AgxComposerField,
  AgxComposerNotices,
  AgxComposerRail,
} from './composer'
export { CommandMenuFeedback, CommandMenuPill, highlightMatch } from './command-menu'
export {
  AgxFilterChip,
  AgxFilterGroup,
  AgxFilterMenu,
  AgxFilterOption,
} from './filter-menu'
export {
  AgxModelPickerOption,
  AgxModelPickerToggle,
  AgxModelPickerTrigger,
} from './model-picker'
export {
  AgxPickerEmpty,
  AgxPickerFill,
  AgxPickerFoot,
  AgxPickerGroup,
  AgxPickerRow,
} from './picker'
export { FLIP_DURATION, FLIP_EASING, playFlip, readRect, useFlipGroup, type FlipOptions, type FlipRect } from './flip'
export { ShimmerBlock, ShimmerText, type ShimmerBlockProps, type ShimmerTextProps } from './shimmer'
export { CopyAction, type CopyActionProps } from './message-actions'
export { PlanRail, type PlanRailEntry, type PlanRailProps } from './plan-rail'
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from './segmented-control'
export { STEERING_LANDED_ATTRIBUTE, useSteeringTransfer } from './steering-transfer'
export { SourceList, type SourceItem, type SourceListProps } from './source-list'
export { ThinkingLoader, type ThinkingLoaderProps } from './thinking-loader'
export { Ticker, type TickerProps } from './ticker'
export { ToasterHost } from './toaster'
