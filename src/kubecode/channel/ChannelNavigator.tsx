import { Hash } from 'lucide-react'

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { StatusBadge } from '@/components/workspace/StatusBadge'
import type { Translator } from '@/lib/i18n'

import type { ChannelThread } from '../api'

export type ChannelNavigatorProps = {
  active: boolean
  onOpen: () => void
  /** Open Threads, most recently active first. */
  onOpenThread: (threadId: string) => void
  /** Lists the Threads only: General has its own entry in the Workspace navigation. */
  threadsOnly?: boolean
  t: Translator
  threads: ChannelThread[]
}

/** The Workspace conversation, above the research list and the Sessions: a Sidebar group. */
export function ChannelNavigator({ active, onOpen, onOpenThread, t, threads, threadsOnly = false }: ChannelNavigatorProps) {
  const label = threadsOnly ? t('kubecode.channel.linkedThreads') : t('kubecode.channel.title')
  return (
    <SidebarGroup aria-label={label} className="p-0" role="region">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {!threadsOnly && (
          <SidebarMenuItem>
            <SidebarMenuButton className="pointer-coarse:min-h-(--ws-touch-target)" aria-current={active ? 'page' : undefined} isActive={active} onClick={onOpen}>
              <Hash aria-hidden="true" />
              <span>{t('kubecode.channel.general')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {threads.slice(0, 5).map((thread) => (
          <SidebarMenuItem key={thread.id}>
            <SidebarMenuButton className="pointer-coarse:min-h-(--ws-touch-target)" onClick={() => onOpenThread(thread.id)}>
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              {thread.research_id && (
                <StatusBadge tone="ok">
                  {t('kubecode.channel.linkedBadge')}
                </StatusBadge>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
