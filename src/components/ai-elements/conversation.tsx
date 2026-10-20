/**
 * Adapted from AI Elements `conversation`
 * (https://ui.shadcn.com/docs/ai-elements/components/conversation,
 * registry https://registry.ai-sdk.dev/conversation.json, ai-elements 1.9.1).
 *
 * Adaptations (ADR 0233): `use-stick-to-bottom` is replaced by a plain
 * scroller that follows new content only while the reader is at the end, so
 * no dependency is added and a reader of long research is never pulled away;
 * the log is named by the caller; strings are the caller's (localized); the
 * scroll button is the Workspace `IconButton`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'

import { IconButton } from '@/components/workspace/IconButton'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import { cn } from '@/lib/utils'

type ConversationContextValue = { atEnd: boolean; scrollToEnd: () => void }

const ConversationContext = createContext<ConversationContextValue | null>(null)

/** Within this many pixels of the end, the reader counts as following along. */
const END_SLACK = 48

export type ConversationProps = ComponentProps<'div'> & {
  /** Names the log, for example "General". */
  label: string
  /** Start at the latest message (chat) rather than the top (a document). */
  initial?: 'end' | 'start'
}

export function Conversation({ children, className, initial = 'end', label, ...props }: ConversationProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [atEnd, setAtEnd] = useState(initial === 'end')
  const following = useRef(initial === 'end')

  const scrollToEnd = useCallback(() => {
    const node = scroller.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    following.current = true
    setAtEnd(true)
  }, [])

  useLayoutEffect(() => {
    const node = scroller.current
    if (initial === 'end' && node) node.scrollTop = node.scrollHeight
  }, [initial])

  // Keep the end in view as content grows, only while the reader is there.
  useEffect(() => {
    const node = scroller.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current) node.scrollTop = node.scrollHeight
    })
    for (const child of Array.from(node.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [])

  const onScroll = () => {
    const node = scroller.current
    if (!node) return
    const end = node.scrollHeight - node.scrollTop - node.clientHeight <= END_SLACK
    following.current = end
    setAtEnd(end)
  }

  const value = useMemo(() => ({ atEnd, scrollToEnd }), [atEnd, scrollToEnd])
  return (
    <ConversationContext.Provider value={value}>
      <div className={cn('kubecode-ai-conversation', className)} {...props}>
        <div aria-label={label} className="kubecode-ai-conversation-scroll" ref={scroller} role="log" tabIndex={0} onScroll={onScroll}>
          {children}
        </div>
      </div>
    </ConversationContext.Provider>
  )
}

export function ConversationContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('kubecode-ai-conversation-content', className)} {...props} />
}

export type ConversationEmptyStateProps = Omit<ComponentProps<'div'>, 'title'> & {
  title: string
  description?: string
  icon?: ReactNode
}

export function ConversationEmptyState({ children, className, description, icon, title, ...props }: ConversationEmptyStateProps) {
  return (
    <div className={cn('kubecode-ai-conversation-empty', className)} {...props}>
      {children ?? (
        <>
          {icon && <div aria-hidden="true" className="kubecode-ai-conversation-empty-icon">{icon}</div>}
          <p className="kubecode-ai-conversation-empty-title">{title}</p>
          {description && <p className="kubecode-ai-conversation-empty-description">{description}</p>}
        </>
      )}
    </div>
  )
}

/** Returns to the latest message; shown only while the reader is elsewhere. */
export function ConversationScrollButton({ className, label }: { className?: string; label: string }) {
  const context = useContext(ConversationContext)
  if (!context || context.atEnd) return null
  return (
    <IconButton
      className={cn('kubecode-ai-conversation-latest', className)}
      icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.latest.Icon} />}
      label={label}
      onClick={context.scrollToEnd}
    />
  )
}
