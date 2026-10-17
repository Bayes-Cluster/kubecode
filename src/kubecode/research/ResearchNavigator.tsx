import { FlaskConical, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

import type { ResearchSummary } from '../api'
import type { ResearchLoadStatus } from './useResearch'

export type ResearchNavigatorProps = {
  activeResearchId: string | null
  items: ResearchSummary[]
  onNew: () => void
  onReload: () => void
  onSelect: (researchId: string) => void
  status: ResearchLoadStatus
  t: Translator
}

/**
 * The Project's research questions, beside its Sessions. Selecting one opens
 * the research surface; Sessions and Teams stay reachable underneath.
 */
export function ResearchNavigator({
  activeResearchId,
  items,
  onNew,
  onReload,
  onSelect,
  status,
  t,
}: ResearchNavigatorProps) {
  return (
    <section aria-label={t('kubecode.research.title')} className="kubecode-research-nav">
      <div className="kubecode-navigator-tools">
        <span>{t('kubecode.research.title')}</span>
        <Button
          aria-label={t('kubecode.research.new')}
          size="icon-xs"
          variant="ghost"
          onClick={onNew}
        >
          <Plus size={16} />
        </Button>
      </div>
      {status === 'loading' && (
        <p className="kubecode-research-nav-note" role="status">{t('kubecode.research.loading')}</p>
      )}
      {status === 'error' && (
        <p className="kubecode-research-nav-note" role="alert">
          {t('kubecode.research.loadFailed')}{' '}
          <Button size="xs" variant="ghost" onClick={onReload}>{t('kubecode.retry')}</Button>
        </p>
      )}
      {status === 'ready' && items.length === 0 && (
        <p className="kubecode-research-nav-note">{t('kubecode.research.empty')}</p>
      )}
      {items.length > 0 && (
        <ul className="kubecode-research-nav-list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                aria-current={item.id === activeResearchId ? 'true' : undefined}
                className="kubecode-research-nav-item"
                type="button"
                onClick={() => onSelect(item.id)}
              >
                <FlaskConical aria-hidden size={14} />
                <span className="kubecode-research-nav-title">{item.title}</span>
                {item.archived && (
                  <span className="kubecode-research-badge" data-tone="muted">
                    {t('kubecode.research.status.archived')}
                  </span>
                )}
                {item.status === 'resolved' && (
                  <span className="kubecode-research-badge" data-tone="muted">
                    {t('kubecode.research.status.resolved')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
