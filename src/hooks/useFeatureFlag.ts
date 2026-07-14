/**
 * Feature flag hook backed by PostHog + release channels.
 *
 * Flags are resolved in order:
 *   1. localStorage override (`ff_<name>`) — for dev/QA testing
 *   2. PostHog feature flags (evaluated by release channel)
 *   3. Alpha channel always returns true (sees all features)
 */

import { isFeatureEnabled } from '../lib/telemetry'

export type FeatureFlagName = 'example_flag'

export function useFeatureFlag(flag: FeatureFlagName): boolean {
  try {
    const override = localStorage.getItem(`ff_${flag}`)
    if (override !== null) return override === 'true'
  } catch {
    // localStorage may be unavailable in some contexts
  }
  return isFeatureEnabled(flag)
}
