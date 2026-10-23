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

import { IconButton } from '@/components/workspace/IconButton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
    <Alert
      className={cn('kubecode-system-message pr-16', className)}
      data-expanded={expanded}
      data-level={level}
      role={role}
      title={message}
      variant={level === 'error' ? 'destructive' : 'default'}
    >
      <Icon />
      {source && <AlertTitle>{source}</AlertTitle>}
      <AlertDescription className="min-w-0 select-text">
        <p
          className={cn(
            'w-full',
            expanded
              ? 'max-h-[min(180px,30vh)] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]'
              : 'truncate',
          )}
        >
          {message}
        </p>
      </AlertDescription>
      <div className="absolute top-2 right-2 flex items-center gap-0.5">
        <IconButton
          aria-expanded={expanded}
          className="[&[aria-expanded=true]>svg]:rotate-180"
          icon={<ChevronDown />}
          label={detailsLabel}
          onClick={() => setExpanded((current) => !current)}
        />
        {onDismiss && <IconButton icon={<X />} label={dismissLabel} onClick={onDismiss} />}
      </div>
    </Alert>
  )
}
