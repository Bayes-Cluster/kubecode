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

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
  const urgent = level === 'warning' || level === 'error'

  return (
    <Alert
      aria-live={urgent ? 'assertive' : 'polite'}
      className={cn('kubecode-system-message', className)}
      data-expanded={expanded}
      data-level={level}
      role={urgent ? 'alert' : 'status'}
      title={message}
      variant={level === 'error' ? 'destructive' : 'default'}
    >
      <Icon />
      {source && <AlertTitle>{source}</AlertTitle>}
      <AlertDescription className="flex min-w-0 items-start gap-1">
        <span
          className={cn(
            'min-w-0 flex-1 select-text',
            expanded ? 'max-h-[min(180px,30vh)] overflow-auto whitespace-pre-wrap break-words' : 'truncate',
          )}
        >
          {message}
        </span>
        <span className="flex shrink-0 items-center">
          <Button
            aria-expanded={expanded}
            aria-label={detailsLabel}
            size="icon-xs"
            title={detailsLabel}
            variant="ghost"
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDown className={expanded ? 'rotate-180' : undefined} />
          </Button>
          {onDismiss && (
            <Button
              aria-label={dismissLabel}
              size="icon-xs"
              variant="ghost"
              onClick={onDismiss}
            >
              <X />
            </Button>
          )}
        </span>
      </AlertDescription>
    </Alert>
  )
}
