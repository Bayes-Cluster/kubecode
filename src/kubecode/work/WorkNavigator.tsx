import { KanbanSquare } from 'lucide-react'

import type { Translator } from '@/lib/i18n'

/** The Workspace's one board, beside the conversation and the research list. */
export function WorkNavigator({
  active,
  onOpen,
  t,
}: {
  active: boolean
  onOpen: () => void
  t: Translator
}) {
  return (
    <section aria-label={t('kubecode.work.title')} className="kubecode-channel-nav">
      <div className="kubecode-navigator-tools">
        <span>{t('kubecode.work.title')}</span>
      </div>
      <ul className="kubecode-research-nav-list">
        <li>
          <button
            aria-current={active ? 'true' : undefined}
            className="kubecode-research-nav-item"
            type="button"
            onClick={onOpen}
          >
            <KanbanSquare aria-hidden size={14} />
            <span className="kubecode-research-nav-title">{t('kubecode.work.board')}</span>
          </button>
        </li>
      </ul>
    </section>
  )
}
