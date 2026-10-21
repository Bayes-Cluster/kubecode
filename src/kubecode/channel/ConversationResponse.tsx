import { useMemo, type ReactNode } from 'react'
import type { StreamdownProps } from 'streamdown'

import { MessageResponse } from '@/components/ai-elements/message'
import type { Translator } from '@/lib/i18n'

import { CONVERSATION_CONTROLS, streamdownTranslations } from './streamdownLabels'

/** An image in a message is its description: nothing is fetched from where an agent points. */
function InertImage({ alt }: { alt?: unknown; node?: unknown }) {
  return <span className="kubecode-inert-image">{typeof alt === 'string' ? alt : ''}</span>
}

/** Emphasis stays `strong` for assistive technology; streamdown draws it as a styled `span`. */
function Strong({ children }: { children?: ReactNode; node?: unknown }) {
  return <strong className="font-semibold" data-streamdown="strong">{children}</strong>
}

const COMPONENTS: StreamdownProps['components'] = { img: InertImage, strong: Strong }

/**
 * A message body in General or a DM: the official `MessageResponse`
 * (hardened streamdown, ADR 0241 §4) with localized copy controls and inert
 * images, as `MarkdownContent images="text"` had them.
 */
export function ConversationResponse({ children, className, t }: { children: string; className?: string; t: Translator }) {
  const translations = useMemo(() => streamdownTranslations(t), [t])
  return (
    <MessageResponse
      className={className}
      components={COMPONENTS}
      controls={CONVERSATION_CONTROLS}
      translations={translations}
    >
      {children}
    </MessageResponse>
  )
}
