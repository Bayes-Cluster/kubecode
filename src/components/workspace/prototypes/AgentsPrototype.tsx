import { useState } from 'react'

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought'
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageAction, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { ViewHeader } from '../ViewHeader'
import { prototypeHash } from './prototypeRoute'
import { FIXTURE_MEMBERS, FIXTURE_TASK_TITLE, FIXTURE_TOOL } from './fixtures'
import { Author, FixtureReference, type ScreenProps } from './shared'

type Decision = 'requested' | 'approved' | 'rejected'

function PendingDecision({ busy, t }: { busy: boolean; t: Translator }) {
  const [decision, setDecision] = useState<Decision>('requested')
  const title = t('kubecode.proto.decision.title', { name: FIXTURE_MEMBERS.turing.name })
  return (
    <Confirmation
      approval={decision === 'requested' ? { id: 'launch' } : { id: 'launch', approved: decision === 'approved' }}
      aria-label={title}
      role="region"
      state={decision === 'requested' ? 'approval-requested' : 'approval-responded'}
    >
      <ConfirmationTitle>
        <strong className="block">{title}</strong>
        <ConfirmationRequest>
          <span className="block">Launch 3 jobs on 2 GPUs each (about 6 GPU-hours). This goes past the round limit you set for RQ-2.</span>
          <span className="block text-muted-foreground">{t('kubecode.proto.decision.scope')}</span>
        </ConfirmationRequest>
        <ConfirmationAccepted><span className="block">{t('kubecode.proto.decision.approved')}</span></ConfirmationAccepted>
        <ConfirmationRejected><span className="block">{t('kubecode.proto.decision.declined')}</span></ConfirmationRejected>
      </ConfirmationTitle>
      <ConfirmationActions>
        <ConfirmationAction variant="outline" onClick={() => setDecision('rejected')}>{t('kubecode.proto.decision.decline')}</ConfirmationAction>
        <ConfirmationAction disabled={busy} onClick={() => setDecision('approved')}>{t('kubecode.proto.decision.allow')}</ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  )
}

export function AgentsMain({ request, t }: Pick<ScreenProps, 'request' | 't'>) {
  const { state } = request
  const [draft, setDraft] = useState('')
  const [stopped, setStopped] = useState(false)
  const empty = state === 'empty'
  const failed = state === 'error'
  const running = !(empty || stopped || failed)

  return (
    <div className="kubecode-proto-conversation">
      <ViewHeader
        className="px-(--ws-space-5) py-(--ws-space-3) max-md:p-(--ws-space-3)"
        icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />}
        level={1}
        meta={empty ? undefined : <Badge variant="secondary">{t('kubecode.proto.agents.working', { count: 2 })}</Badge>}
        title={t('kubecode.channel.general')}
      />
      <Conversation aria-label={t('kubecode.channel.general')} initial="instant">
        {empty ? (
          <ConversationEmptyState
            description={t('kubecode.proto.agents.emptyDescription')}
            title={t('kubecode.proto.agents.emptyTitle')}
          />
        ) : (
          <ConversationContent className="mx-auto w-full max-w-(--ws-conversation-width)">
            <Message from="user">
              <Author member={FIXTURE_MEMBERS.self} time="11:02" />
              <MessageContent>
                <MessageResponse>@general go ahead with the ablation in RQ-2 and run the three seeds.</MessageResponse>
              </MessageContent>
            </Message>
            <Message from="assistant">
              <Author member={FIXTURE_MEMBERS.general} time="11:03" />
              <MessageContent>
                <MessageResponse>
                  Started on your instruction. Turing runs the seed sweep; Noether prepares the analysis as runs finish.
                </MessageResponse>
                <Task defaultOpen={false}>
                  <TaskTrigger title={t('kubecode.proto.agents.plan', { count: 3 })} />
                  <TaskContent>
                    <TaskItem>Turing: run seeds 1–3 at 16k, 32k and 64k</TaskItem>
                    <TaskItem>Noether: compute recall@10 with 95% intervals</TaskItem>
                    <TaskItem>General Agent: request your review with the evidence</TaskItem>
                  </TaskContent>
                </Task>
                <FixtureReference kind="task" t={t} title={FIXTURE_TASK_TITLE} />
              </MessageContent>
            </Message>
            <Message from="assistant">
              <Author
                activity={stopped ? t('kubecode.proto.agents.stopped') : <Shimmer as="span">{t('kubecode.proto.agents.running')}</Shimmer>}
                member={FIXTURE_MEMBERS.turing}
                time="11:05"
              />
              <MessageContent className="w-full">
                <Tool defaultOpen>
                  <ToolHeader
                    state={failed ? 'output-error' : stopped ? 'output-denied' : 'input-available'}
                    statusLabel={failed ? t('kubecode.proto.tool.failed') : stopped ? t('kubecode.proto.agents.stopped') : t('kubecode.proto.tool.running')}
                    title="launch_experiment"
                    type="tool-launch_experiment"
                  />
                  <ToolContent>
                    <ToolInput input={JSON.parse(FIXTURE_TOOL.launch)} label={t('kubecode.proto.tool.input')} />
                    <ToolOutput
                      errorLabel={t('kubecode.proto.tool.error')}
                      errorText={failed ? FIXTURE_TOOL.failure : undefined}
                      output={undefined}
                    />
                  </ToolContent>
                </Tool>
                {failed && (
                  <Alert role="alert" variant="destructive">
                    <AlertDescription className="flex flex-wrap items-center gap-2">
                      <span>{t('kubecode.proto.agents.failedHint', { name: FIXTURE_MEMBERS.turing.name })}</span>
                      <MessageAction label={t('kubecode.vocab.command.retry')} tooltip={t('kubecode.vocab.command.retry')}>
                        <Icon role="command" source={WORKSPACE_COMMAND_ICONS.retry.Icon} />
                      </MessageAction>
                    </AlertDescription>
                  </Alert>
                )}
                <ChainOfThought defaultOpen>
                  <ChainOfThoughtHeader>{t('kubecode.proto.activity')}</ChainOfThoughtHeader>
                  <ChainOfThoughtContent>
                    <ChainOfThoughtStep description={t('kubecode.proto.step.complete')} label="Prepared configs for 9 runs" status="complete" />
                    <ChainOfThoughtStep description={t('kubecode.proto.step.complete')} label="Seed 1 at 16k and 32k" status="complete" />
                    <ChainOfThoughtStep
                      description={failed ? t('kubecode.proto.tool.failed') : `${t('kubecode.proto.step.active')} · Waiting for GPU capacity`}
                      label="Seed 1 at 64k"
                      status="active"
                    />
                    <ChainOfThoughtStep description={t('kubecode.proto.step.pending')} label="Seeds 2 and 3" status="pending" />
                  </ChainOfThoughtContent>
                </ChainOfThought>
              </MessageContent>
            </Message>
            <Message from="assistant">
              <Author activity={t('kubecode.proto.agents.waiting')} member={FIXTURE_MEMBERS.noether} time="11:07" />
              <MessageContent className="w-full">
                <Tool>
                  <ToolHeader state="output-available" statusLabel={t('kubecode.proto.tool.completed')} title="load_results" type="tool-load_results" />
                  <ToolContent>
                    <ToolOutput errorText={undefined} output={FIXTURE_TOOL.loadOutput} resultLabel={t('kubecode.proto.tool.output')} />
                  </ToolContent>
                </Tool>
              </MessageContent>
            </Message>
            {!failed && <PendingDecision busy={state === 'busy'} t={t} />}
          </ConversationContent>
        )}
        <ConversationScrollButton aria-label={t('kubecode.vocab.command.latest')} />
      </Conversation>
      <div className="kubecode-proto-dock mx-auto w-full max-w-(--ws-composer-width)">
        <PromptInput uploadLabel={t('kubecode.vocab.command.attachFile')} onSubmit={() => setDraft('')}>
          <PromptInputBody>
            <PromptInputTextarea
              aria-label={t('kubecode.proto.composerLabel')}
              placeholder={t('kubecode.channel.composerPlaceholder')}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit
              aria-label={running ? t('kubecode.proto.agents.stop', { name: FIXTURE_MEMBERS.turing.name }) : t('kubecode.channel.send')}
              disabled={!running && !draft.trim()}
              status={running ? 'streaming' : undefined}
              onStop={() => setStopped(true)}
            />
          </PromptInputFooter>
        </PromptInput>
        <p className="kubecode-proto-note">{t('kubecode.proto.mentionRule')}</p>
      </div>
    </div>
  )
}

export function WorkQueue({ request, t }: Pick<ScreenProps, 'request' | 't'>) {
  const empty = request.state === 'empty'
  return (
    <div className="kubecode-proto-inspector-body">
      <ViewHeader level={2} title={t('kubecode.proto.work')} />
      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('kubecode.proto.work')}</EmptyTitle>
            <EmptyDescription>{t('kubecode.proto.queue.empty')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Queue aria-label={t('kubecode.proto.work')}>
          <QueueSection>
            <QueueSectionTrigger><QueueSectionLabel label={t('kubecode.proto.queue.running', { count: 2 })} /></QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList aria-label={t('kubecode.proto.queue.running', { count: 2 })}>
                <QueueItem>
                  <div className="flex items-center gap-2">
                    <QueueItemIndicator />
                    <QueueItemContent>Seed sweep · {FIXTURE_MEMBERS.turing.name}</QueueItemContent>
                  </div>
                  <QueueItemDescription>{request.state === 'error' ? t('kubecode.proto.tool.failed') : t('kubecode.proto.step.active')}</QueueItemDescription>
                </QueueItem>
                <QueueItem>
                  <div className="flex items-center gap-2">
                    <QueueItemIndicator />
                    <QueueItemContent>Recall analysis · {FIXTURE_MEMBERS.noether.name}</QueueItemContent>
                  </div>
                  <QueueItemDescription>{t('kubecode.proto.agents.waiting')}</QueueItemDescription>
                </QueueItem>
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
          <QueueSection>
            <QueueSectionTrigger><QueueSectionLabel label={t('kubecode.proto.queue.queued', { count: 1 })} /></QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList aria-label={t('kubecode.proto.queue.queued', { count: 1 })}>
                <QueueItem>
                  <div className="flex items-center gap-2">
                    <QueueItemIndicator />
                    <QueueItemContent>Request review · {FIXTURE_MEMBERS.general.name}</QueueItemContent>
                  </div>
                </QueueItem>
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
          <QueueSection defaultOpen={false}>
            <QueueSectionTrigger><QueueSectionLabel label={t('kubecode.proto.queue.done', { count: 1 })} /></QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList aria-label={t('kubecode.proto.queue.done', { count: 1 })}>
                <QueueItem>
                  <div className="flex items-center gap-2">
                    <QueueItemIndicator completed />
                    <QueueItemContent completed>Prepare configs · {FIXTURE_MEMBERS.turing.name}</QueueItemContent>
                  </div>
                  <QueueItemDescription completed>{t('kubecode.proto.step.complete')}</QueueItemDescription>
                </QueueItem>
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </Queue>
      )}
      <a className="kubecode-proto-link" href={prototypeHash({ ...request, screen: 'review', from: 'agents', state: 'default' })}>
        {t('kubecode.proto.openReview')}
      </a>
    </div>
  )
}
