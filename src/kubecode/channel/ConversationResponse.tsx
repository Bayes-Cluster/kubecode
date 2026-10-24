import { useMemo } from 'react'
import type { StreamdownProps } from 'streamdown'

import { MessageResponse } from '@/components/ai-elements/message'
import type { Translator } from '@/lib/i18n'

import { prepareInlineMath } from '../markdown/inlineMath'
import { InertImage, PROSE_ROOT, Strong } from '../markdown/MarkdownParts'
import { CONVERSATION_CONTROLS, streamdownTranslations } from './streamdownLabels'

const COMPONENTS: StreamdownProps['components'] = { img: InertImage, strong: Strong }

/**
 * A message body in General, a DM, or the DM share preview: the official
 * `MessageResponse` (hardened streamdown, ADR 0241 §4) with localized copy
 * controls, inert images and strict inline math (ADR 0229 §7). `[[…]]` is
 * not parsed here: General and DMs never had wikilink navigation (ADR 0255).
 */
export function ConversationResponse({ children, className, t }: { children: string; className?: string; t: Translator }) {
  const translations = useMemo(() => streamdownTranslations(t), [t])
  const source = useMemo(() => prepareInlineMath(children), [children])
  return (
    <MessageResponse
      {...PROSE_ROOT}
      className={className}
      components={COMPONENTS}
      controls={CONVERSATION_CONTROLS}
      data-testid="conversation-response"
      translations={translations}
    >
      {source}
    </MessageResponse>
  )
}
