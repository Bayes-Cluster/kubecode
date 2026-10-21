import { useState } from 'react'

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  Message,
  MessageContent,
  MessageResponse,
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
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
  Shimmer,
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ConfirmationState,
} from '@/components/ai-elements'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { Composer } from '../Composer'
import { DecisionButton } from '../DecisionButton'
import { IconButton } from '../IconButton'
import { StatusBadge } from '../StatusBadge'
import { ViewHeader } from '../ViewHeader'
import { prototypeHash } from './prototypeRoute'
import { FIXTURE_MEMBERS, FIXTURE_MENTIONS, FIXTURE_TASK_TITLE, FIXTURE_TOOL } from './fixtures'
import { Author, FixtureReference, type ScreenProps } from './shared'

function PendingDecision({ busy, t }: { busy: boolean; t: Translator }) {
  const [state, setState] = useState<ConfirmationState>('requested')
  return (
    <Confirmation state={state}>
      <ConfirmationTitle>{t('kubecode.proto.decision.title', { name: FIXTURE_MEMBERS.turing.name })}</ConfirmationTitle>
      <ConfirmationRequest>
        <p>Launch 3 jobs on 2 GPUs each (about 6 GPU-hours). This goes past the round limit you set for RQ-2.</p>
        <p className="kubecode-proto-note">{t('kubecode.proto.decision.scope')}</p>
      </ConfirmationRequest>
      <ConfirmationAccepted><p>{t('kubecode.proto.decision.approved')}</p></ConfirmationAccepted>
      <ConfirmationRejected><p>{t('kubecode.proto.decision.declined')}</p></ConfirmationRejected>
      <ConfirmationActions>
        <DecisionButton variant="secondary" onDecide={() => setState('rejected')}>{t('kubecode.proto.decision.decline')}</DecisionButton>
        <DecisionButton busy={busy} variant="primary" onDecide={() => setState('approved')}>{t('kubecode.proto.decision.allow')}</DecisionButton>
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

  return (
    <div className="kubecode-proto-conversation">
      <ViewHeader
        icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />}
        level={1}
        meta={empty ? undefined : <StatusBadge tone="info">{t('kubecode.proto.agents.working', { count: 2 })}</StatusBadge>}
        title={t('kubecode.channel.general')}
      />
      <Conversation initial="end" label={t('kubecode.channel.general')}>
        {empty ? (
          <ConversationEmptyState
            description={t('kubecode.proto.agents.emptyDescription')}
            title={t('kubecode.proto.agents.emptyTitle')}
          />
        ) : (
          <ConversationContent>
            <Message author={<Author member={FIXTURE_MEMBERS.self} time="11:02" />} from="self">
              <MessageContent>
                <MessageResponse><p>@general go ahead with the ablation in RQ-2 and run the three seeds.</p></MessageResponse>
              </MessageContent>
            </Message>
            <Message author={<Author member={FIXTURE_MEMBERS.general} time="11:03" />} from="member">
              <MessageContent>
                <MessageResponse>
                  <p>Started on your instruction. Turing runs the seed sweep; Noether prepares the analysis as runs finish.</p>
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
            <Message
              author={<Author activity={stopped ? t('kubecode.proto.agents.stopped') : <Shimmer>{t('kubecode.proto.agents.running')}</Shimmer>} member={FIXTURE_MEMBERS.turing} time="11:05" />}
              from="member"
            >
              <MessageContent>
                <Tool defaultOpen>
                  <ToolHeader
                    state={failed ? 'failed' : stopped ? 'denied' : 'running'}
                    stateLabel={failed ? t('kubecode.proto.tool.failed') : stopped ? t('kubecode.proto.agents.stopped') : t('kubecode.proto.tool.running')}
                    title="launch_experiment"
                  />
                  <ToolContent>
                    <ToolInput input={FIXTURE_TOOL.launch} label={t('kubecode.proto.tool.input')} />
                    <ToolOutput errorText={failed ? FIXTURE_TOOL.failure : undefined} label={t('kubecode.proto.tool.error')} />
                  </ToolContent>
                </Tool>
                {failed && (
                  <p className="kubecode-proto-delivery" role="alert">
                    <span>{t('kubecode.proto.agents.failedHint', { name: FIXTURE_MEMBERS.turing.name })}</span>
                    <IconButton icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.retry.Icon} />} label={t('kubecode.vocab.command.retry')} />
                  </p>
                )}
                <ChainOfThought defaultOpen>
                  <ChainOfThoughtHeader>{t('kubecode.proto.activity')}</ChainOfThoughtHeader>
                  <ChainOfThoughtContent>
                    <ChainOfThoughtStep label="Prepared configs for 9 runs" status="complete" statusLabel={t('kubecode.proto.step.complete')} />
                    <ChainOfThoughtStep label="Seed 1 at 16k and 32k" status="complete" statusLabel={t('kubecode.proto.step.complete')} />
                    <ChainOfThoughtStep
                      description="Waiting for GPU capacity"
                      label="Seed 1 at 64k"
                      status={failed ? 'failed' : 'active'}
                      statusLabel={failed ? t('kubecode.proto.tool.failed') : t('kubecode.proto.step.active')}
                    />
                    <ChainOfThoughtStep label="Seeds 2 and 3" status="pending" statusLabel={t('kubecode.proto.step.pending')} />
                  </ChainOfThoughtContent>
                </ChainOfThought>
              </MessageContent>
            </Message>
            <Message author={<Author activity={t('kubecode.proto.agents.waiting')} member={FIXTURE_MEMBERS.noether} time="11:07" />} from="member">
              <MessageContent>
                <Tool>
                  <ToolHeader state="completed" stateLabel={t('kubecode.proto.tool.completed')} title="load_results" />
                  <ToolContent>
                    <ToolOutput label={t('kubecode.proto.tool.output')} output={FIXTURE_TOOL.loadOutput} />
                  </ToolContent>
                </Tool>
              </MessageContent>
            </Message>
            {!failed && <PendingDecision busy={state === 'busy'} t={t} />}
          </ConversationContent>
        )}
        <ConversationScrollButton label={t('kubecode.vocab.command.latest')} />
      </Conversation>
      <div className="kubecode-proto-dock">
        <PromptInput>
          <PromptInputBody>
            <Composer
              label={t('kubecode.proto.composerLabel')}
              mentionLabel={t('kubecode.vocab.command.mention')}
              mentions={FIXTURE_MENTIONS}
              placeholder={t('kubecode.channel.composerPlaceholder')}
              rows={2}
              sendLabel={t('kubecode.channel.send')}
              stop={empty || stopped || failed ? undefined : {
                label: t('kubecode.proto.agents.stop', { name: FIXTURE_MEMBERS.turing.name }),
                shortLabel: t('kubecode.vocab.command.stopRun'),
                onStop: () => setStopped(true),
              }}
              value={draft}
              onChange={setDraft}
              onSend={() => setDraft('')}
            />
          </PromptInputBody>
          <PromptInputFooter>{t('kubecode.proto.mentionRule')}</PromptInputFooter>
        </PromptInput>
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
        <p className="kubecode-proto-note">{t('kubecode.proto.queue.empty')}</p>
      ) : (
        <Queue aria-label={t('kubecode.proto.work')}>
          <QueueSection>
            <QueueSectionTrigger><QueueSectionLabel label={t('kubecode.proto.queue.running', { count: 2 })} /></QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList label={t('kubecode.proto.queue.running', { count: 2 })}>
                <QueueItem>
                  <QueueItemIndicator />
                  <QueueItemContent>Seed sweep · {FIXTURE_MEMBERS.turing.name}</QueueItemContent>
                  <QueueItemDescription>{request.state === 'error' ? t('kubecode.proto.tool.failed') : t('kubecode.proto.step.active')}</QueueItemDescription>
                </QueueItem>
                <QueueItem>
                  <QueueItemIndicator />
                  <QueueItemContent>Recall analysis · {FIXTURE_MEMBERS.noether.name}</QueueItemContent>
                  <QueueItemDescription>{t('kubecode.proto.agents.waiting')}</QueueItemDescription>
                </QueueItem>
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
          <QueueSection>
            <QueueSectionTrigger><QueueSectionLabel label={t('kubecode.proto.queue.queued', { count: 1 })} /></QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList label={t('kubecode.proto.queue.queued', { count: 1 })}>
                <QueueItem>
                  <QueueItemIndicator />
                  <QueueItemContent>Request review · {FIXTURE_MEMBERS.general.name}</QueueItemContent>
                </QueueItem>
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
          <QueueSection defaultOpen={false}>
            <QueueSectionTrigger><QueueSectionLabel label={t('kubecode.proto.queue.done', { count: 1 })} /></QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList label={t('kubecode.proto.queue.done', { count: 1 })}>
                <QueueItem completed>
                  <QueueItemIndicator completed />
                  <QueueItemContent>Prepare configs · {FIXTURE_MEMBERS.turing.name}</QueueItemContent>
                  <QueueItemDescription>{t('kubecode.proto.step.complete')}</QueueItemDescription>
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
