import { FlaskConical, Plus } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { StatusBadge } from '@/components/workspace/StatusBadge'
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
 * The Project's research questions, beside its Sessions: a Sidebar group.
 * Selecting one opens the research surface; Sessions and Teams stay reachable
 * underneath.
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
    <SidebarGroup aria-label={t('kubecode.research.title')} className="p-0" role="region">
      <SidebarGroupLabel>{t('kubecode.research.title')}</SidebarGroupLabel>
      <SidebarGroupAction aria-label={t('kubecode.research.new')} title={t('kubecode.research.new')} onClick={onNew}>
        <Plus aria-hidden="true" />
      </SidebarGroupAction>
      <SidebarGroupContent>
        {status === 'loading' && (
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground" role="status">
            <Spinner aria-hidden="true" role="presentation" />
            {t('kubecode.research.loading')}
          </div>
        )}
        {status === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>
              <p>{t('kubecode.research.loadFailed')}</p>
              <Button size="xs" variant="outline" onClick={onReload}>{t('kubecode.retry')}</Button>
            </AlertDescription>
          </Alert>
        )}
        {status === 'ready' && items.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t('kubecode.research.empty')}</p>
        )}
        {items.length > 0 && (
          <SidebarMenu>
            {items.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  className="pointer-coarse:min-h-11"
                  aria-current={item.id === activeResearchId ? 'true' : undefined}
                  isActive={item.id === activeResearchId}
                  onClick={() => onSelect(item.id)}
                >
                  <FlaskConical aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.archived && (
                    <StatusBadge tone="muted">{t('kubecode.research.status.archived')}</StatusBadge>
                  )}
                  {item.status === 'resolved' && (
                    <StatusBadge tone="muted">{t('kubecode.research.status.resolved')}</StatusBadge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
