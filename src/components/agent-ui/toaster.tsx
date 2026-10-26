import type { ToasterProps } from 'sonner'

import { Toaster as SonnerHost } from '@/components/ui/sonner'

// The host engine's own stylesheet was never imported anywhere (ADR 0257 §6),
// so toasts rendered unstyled since ADR 0256 shipped the host. The
// presentation owner loads it, then paints the Clean skin on top of the
// documented `[data-sonner-*]` extension points.
import 'sonner/dist/styles.css'

import './toaster.css'

/**
 * ADR 0257, recreating the affectUI "Toaster" presentation
 * (https://www.affectui.com/components/toaster, Clean preview, captured
 * 2026-10-26) on the Sonner host whose semantics ADR 0256 §3 fixes: one
 * host, the newest three visible, repeated messages shown once, every
 * message kept until closed, the localized region and close labels. The
 * stack, swipe, promise and timer behaviour are the host engine's; this
 * component owns the Clean card presentation (radius, hairline float shadow,
 * type scale, status icon tones, coarse-pointer and narrow-screen sizing)
 * through the host's documented `[data-sonner-*]` extension points — the
 * narrow engine exception of ADR 0257 §6, baselined rule by rule.
 *
 * Copy and semantics stay where they were: callers publish through the
 * SystemMessageProvider and pass the localized labels here as before.
 */

export function ToasterHost(props: ToasterProps) {
  return <SonnerHost {...props} />
}
