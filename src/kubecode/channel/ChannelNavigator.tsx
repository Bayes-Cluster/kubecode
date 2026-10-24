import { Hash } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import type { Translator } from '@/lib/i18n'

import type { ChannelThread } from '../api'
import { useSidebarMenuSize } from '../app/useSidebarMenuSize'

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
  const menuSize = useSidebarMenuSize()
  const label = threadsOnly ? t('kubecode.channel.linkedThreads') : t('kubecode.channel.title')
  return (
    <SidebarGroup aria-label={label} className="p-0" role="region">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {!threadsOnly && (
          <SidebarMenuItem>
            <SidebarMenuButton aria-current={active ? 'page' : undefined} isActive={active} size={menuSize} onClick={onOpen}>
              <Hash aria-hidden="true" />
              <span>{t('kubecode.channel.general')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {threads.slice(0, 5).map((thread) => (
          <SidebarMenuItem key={thread.id}>
            <SidebarMenuButton size={menuSize} onClick={() => onOpenThread(thread.id)}>
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              {thread.research_id && (
                <Badge variant="success">
                  {t('kubecode.channel.linkedBadge')}
                </Badge>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
