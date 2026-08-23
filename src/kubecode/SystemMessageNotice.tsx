import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Bug,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  SystemMessageContext,
  type SystemMessage,
} from './systemMessages'

type PublishedSystemMessage = SystemMessage & { id: number }

export function SystemMessageProvider({
  children,
  detailsLabel,
  dismissLabel,
}: {
  children: ReactNode
  detailsLabel: string
  dismissLabel: string
}) {
  const [messages, setMessages] = useState<PublishedSystemMessage[]>([])
  const nextIdRef = useRef(1)
  const publish = useCallback((message: SystemMessage) => {
    const published = { ...message, id: nextIdRef.current++ }
    setMessages((current) => {
      const duplicate = current.some((item) => (
        item.level === message.level
          && item.message === message.message
          && item.source === message.source
      ))
      return duplicate ? current : [...current.slice(-2), published]
    })
  }, [])
  const api = useMemo(() => ({ publish }), [publish])
  const dismiss = (id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id))
  }

  return (
    <SystemMessageContext value={api}>
      {children}
      {messages.length > 0 && (
        <div className="kubecode-system-message-host">
          {messages.map((message) => (
            <SystemMessageNotice
              detailsLabel={detailsLabel}
              dismissLabel={dismissLabel}
              key={message.id}
              level={message.level}
              message={message.message}
              source={message.source}
              onDismiss={() => dismiss(message.id)}
            />
          ))}
        </div>
      )}
    </SystemMessageContext>
  )
}

type SystemMessageNoticeProps = SystemMessage & {
  className?: string
  detailsLabel: string
  dismissLabel: string
  onDismiss?: () => void
}

const LEVEL_ICONS = {
  debug: Bug,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
} as const

export function SystemMessageNotice({
  className,
  detailsLabel,
  dismissLabel,
  level,
  message,
  onDismiss,
  source,
}: SystemMessageNoticeProps) {
  const [expanded, setExpanded] = useState(false)
  const Icon = LEVEL_ICONS[level]
  const role = level === 'warning' || level === 'error' ? 'alert' : 'status'

  return (
    <div
      className={cn('kubecode-system-message', className)}
      data-expanded={expanded}
      data-level={level}
      role={role}
      title={message}
    >
      <Icon className="kubecode-system-message-icon" fill="currentColor" />
      <div
        className="kubecode-system-message-content"
        title={message}
      >
        {source && <strong>{source}</strong>}
        <span>{message}</span>
      </div>
      <Button
        aria-expanded={expanded}
        aria-label={detailsLabel}
        className="kubecode-system-message-expand"
        size="icon-xs"
        title={detailsLabel}
        variant="ghost"
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronDown  size={16}/>
      </Button>
      {onDismiss && (
        <Button
          aria-label={dismissLabel}
          className="kubecode-system-message-dismiss"
          size="icon-xs"
          variant="ghost"
          onClick={onDismiss}
        >
          <X  size={16}/>
        </Button>
      )}
    </div>
  )
}
