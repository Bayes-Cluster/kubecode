import { useId, useState, type ReactNode } from 'react'

import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { CodeBlock, CodeBlockCopyButton } from '@/components/ai-elements/code-block'
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Plan, PlanContent, PlanDescription, PlanHeader, PlanTitle, PlanTrigger } from '@/components/ai-elements/plan'
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConversationComposer } from '@/kubecode/channel/ConversationComposer'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

function Section({ children, title }: { children: ReactNode; title: string }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="kubecode-control-matrix-section">
      <h2 id={id}>{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Row({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="kubecode-control-matrix-row">
      <span className="kubecode-control-matrix-state">{label}</span>
      <div className="kubecode-control-matrix-cells">{children}</div>
    </div>
  )
}

const SAMPLE_CODE = 'import torch\n\nscores = model(batch).logits.softmax(-1)\nprint(scores.topk(10).indices)'

/**
 * The official shadcn/ui components and AI Elements (ADR 0241) in their
 * states, themed through the Workspace tokens, with every label from the
 * locale catalogs. Later slices build product surfaces from these parts, so
 * this section is their visual reference.
 */
export function OfficialComponentMatrix({ t }: { t: Translator }) {
  const [draft, setDraft] = useState('')
  const fieldId = useId()
  const say = (key: Parameters<Translator>[0], values?: Parameters<Translator>[1]) => t(key, values)

  return (
    <div className="flex flex-col gap-6" data-testid="official-components">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{say('kubecode.matrix.official.title')}</h2>
        <p className="text-muted-foreground text-sm">{say('kubecode.matrix.official.description')}</p>
      </header>

      <Section title={say('kubecode.matrix.official.section.actions')}>
        <Row label={say('kubecode.matrix.state.default')}>
          <Button>{say('kubecode.task.acceptResults')}</Button>
          <Button variant="outline">{say('kubecode.task.sendBack')}</Button>
          <Button variant="secondary">{say('kubecode.vocab.command.reply')}</Button>
          <Button variant="ghost">{say('kubecode.vocab.command.share')}</Button>
          <Button variant="destructive">{say('kubecode.vocab.command.remove')}</Button>
          <ButtonGroup aria-label={say('kubecode.proto.messageActions')}>
            <Button aria-label={say('kubecode.vocab.command.reply')} size="icon" variant="outline">
              <Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />
            </Button>
            <Button aria-label={say('kubecode.vocab.command.copyLink')} size="icon" variant="outline">
              <Icon role="command" source={WORKSPACE_COMMAND_ICONS.copyLink.Icon} />
            </Button>
          </ButtonGroup>
          <KbdGroup aria-label={say('kubecode.matrix.official.sample.shortcut')}>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Row>
        <Row label={say('kubecode.matrix.state.disabled')}>
          <Button disabled>{say('kubecode.task.acceptResults')}</Button>
          <Button disabled variant="outline">{say('kubecode.task.sendBack')}</Button>
        </Row>
        <Row label={say('kubecode.matrix.state.busy')}>
          <Button disabled>
            <Spinner aria-label={say('kubecode.matrix.sample.sending')} />
            {say('kubecode.matrix.sample.sending')}
          </Button>
        </Row>
      </Section>

      <Section title={say('kubecode.matrix.official.section.display')}>
        <Row label={say('kubecode.matrix.state.default')}>
          <Badge>{say('kubecode.matrix.sample.ok')}</Badge>
          <Badge variant="secondary">{say('kubecode.matrix.sample.info')}</Badge>
          <Badge variant="outline">{say('kubecode.matrix.sample.muted')}</Badge>
          <Badge variant="destructive">{say('kubecode.matrix.sample.danger')}</Badge>
          <HoverCard>
            <HoverCardTrigger asChild>
              <Button className="gap-2" variant="ghost">
                <Avatar className="size-6"><AvatarFallback>GA</AvatarFallback></Avatar>
                General
              </Button>
            </HoverCardTrigger>
            <HoverCardContent>{say('kubecode.matrix.sample.managerRole')}</HoverCardContent>
          </HoverCard>
        </Row>
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{say('kubecode.matrix.sample.longTitle')}</CardTitle>
              <CardDescription>{say('kubecode.matrix.sample.headerDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Badge variant="secondary">{say('kubecode.matrix.sample.info')}</Badge>
              <Badge variant="outline">v3</Badge>
            </CardContent>
          </Card>
          <Item variant="outline">
            <ItemMedia>
              <Avatar><AvatarFallback>DA</AvatarFallback></Avatar>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Data Analyst</ItemTitle>
              <ItemDescription>{say('kubecode.matrix.sample.specialistRole')}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Badge variant="secondary">{say('kubecode.matrix.sample.running')}</Badge>
            </ItemActions>
          </Item>
        </div>
      </Section>

      <Section title={say('kubecode.matrix.official.section.feedback')}>
        <Alert>
          <AlertTitle>{say('kubecode.matrix.sample.needsSetup')}</AlertTitle>
          <AlertDescription>{say('kubecode.matrix.sample.disabledReason')}</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>{say('kubecode.proto.notDelivered')}</AlertTitle>
          <AlertDescription>{say('kubecode.proto.notDeliveredHint')}</AlertDescription>
        </Alert>
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyTitle>{say('kubecode.proto.review.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{say('kubecode.proto.review.emptyDescription')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <Row label={say('kubecode.matrix.state.busy')}>
          <Spinner aria-label={say('kubecode.matrix.sample.sending')} />
          <Shimmer as="span">{say('kubecode.proto.writing')}</Shimmer>
          <div className="flex w-48 flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </Row>
      </Section>

      <Section title={say('kubecode.matrix.official.section.forms')}>
        <FieldGroup className="max-w-md">
          <Field>
            <FieldLabel htmlFor={fieldId}>{say('kubecode.matrix.official.sample.fieldLabel')}</FieldLabel>
            <InputGroup>
              <InputGroupInput id={fieldId} placeholder={say('kubecode.matrix.sample.longTitle')} />
              <InputGroupAddon align="inline-end">
                <InputGroupButton aria-label={say('kubecode.vocab.command.add')} size="icon-xs">
                  <Icon role="command" source={WORKSPACE_COMMAND_ICONS.add.Icon} />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>{say('kubecode.matrix.official.sample.fieldHelp')}</FieldDescription>
          </Field>
        </FieldGroup>
        <Command className="max-w-md rounded-lg border" label={say('kubecode.matrix.sample.mentionLabel')}>
          <CommandInput aria-label={say('kubecode.matrix.sample.mentionLabel')} placeholder={say('kubecode.matrix.sample.mentionLabel')} />
          <CommandList>
            <CommandEmpty>{say('kubecode.matrix.official.sample.noMatch')}</CommandEmpty>
            <CommandGroup heading={say('kubecode.vocab.destination.members')}>
              <CommandItem>General</CommandItem>
              <CommandItem>Data Analyst</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </Section>

      <Section title={say('kubecode.matrix.official.section.overlays')}>
        <Row label={say('kubecode.matrix.state.default')}>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">{say('kubecode.matrix.official.sample.openSheet')}</Button>
            </SheetTrigger>
            <SheetContent closeLabel={say('kubecode.vocab.command.close')}>
              <SheetHeader>
                <SheetTitle>{say('kubecode.matrix.sample.longTitle')}</SheetTitle>
                <SheetDescription>{say('kubecode.matrix.sample.headerDescription')}</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
        </Row>
        <Accordion className="max-w-md" collapsible type="single">
          <AccordionItem value="evidence">
            <AccordionTrigger>{say('kubecode.matrix.official.sample.accordionTitle')}</AccordionTrigger>
            <AccordionContent>{say('kubecode.matrix.official.sample.accordionBody')}</AccordionContent>
          </AccordionItem>
        </Accordion>
        <Separator />
      </Section>

      <Section title={say('kubecode.matrix.official.section.conversation')}>
        <div className="flex max-w-3xl flex-col gap-4">
          <Message from="user">
            <MessageContent>
              <MessageResponse>{'@general compare **dense** and *windowed* recall at 64k, with $\\Delta = r_d - r_w$.'}</MessageResponse>
            </MessageContent>
          </Message>
          <Message from="assistant">
            <MessageContent>
              <MessageResponse>{'Recall@10 holds within 2.4 points ([table](https://example.org/recall)).\n\n$$\\Delta_{64k} = 0.904 - 0.880 = 0.024$$'}</MessageResponse>
              <Sources>
                <SourcesTrigger count={1}>{say('kubecode.proto.sources', { count: 1 })}</SourcesTrigger>
                <SourcesContent>
                  <Source href="https://arxiv.org/abs/2004.05150" title="papers/longformer-2020.pdf" />
                </SourcesContent>
              </Sources>
            </MessageContent>
            <MessageActions>
              <MessageAction label={say('kubecode.vocab.command.reply')} tooltip={say('kubecode.vocab.command.reply')}>
                <Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />
              </MessageAction>
              <MessageAction label={say('kubecode.vocab.command.copyLink')} tooltip={say('kubecode.vocab.command.copyLink')}>
                <Icon role="command" source={WORKSPACE_COMMAND_ICONS.copyLink.Icon} />
              </MessageAction>
            </MessageActions>
          </Message>
          <div aria-label={say('kubecode.proto.suggestions')} role="group">
            <Suggestions>
              <Suggestion suggestion={say('kubecode.proto.suggest.summarize')} onClick={setDraft} />
              <Suggestion suggestion={say('kubecode.proto.suggest.ask')} onClick={setDraft} />
            </Suggestions>
          </div>
          {/* ADR 0247: the production composer, never a demo-only Prompt Input. */}
          <ConversationComposer
            attachLabel={say('kubecode.vocab.command.attachFile')}
            label={say('kubecode.matrix.sample.composerLabel')}
            placeholder={say('kubecode.matrix.sample.composerLabel')}
            sendLabel={say('kubecode.vocab.command.send')}
            value={draft}
            onChange={setDraft}
            onSend={() => setDraft('')}
          />
          <ConversationComposer
            attachLabel={say('kubecode.vocab.command.attachFile')}
            label={say('kubecode.matrix.sample.composerLabel')}
            placeholder={say('kubecode.matrix.sample.composerLabel')}
            sendLabel={say('kubecode.vocab.command.send')}
            stop={{ label: say('kubecode.matrix.sample.stopAnalyst'), onStop: () => undefined }}
            value=""
            onChange={() => undefined}
            onSend={() => undefined}
          />
        </div>
      </Section>

      <Section title={say('kubecode.matrix.official.section.agentWork')}>
        <div className="flex max-w-3xl flex-col gap-4">
          <Tool>
            <ToolHeader state="input-available" statusLabel={say('kubecode.proto.tool.running')} title="launch_experiment" type="tool-launch_experiment" />
          </Tool>
          <Tool defaultOpen>
            <ToolHeader state="output-available" statusLabel={say('kubecode.proto.tool.completed')} title="load_results" type="tool-load_results" />
            <ToolContent>
              <ToolInput input={{ runs: 9 }} label={say('kubecode.proto.tool.input')} />
              <ToolOutput errorText={undefined} output="Loaded 9 runs." resultLabel={say('kubecode.proto.tool.output')} />
            </ToolContent>
          </Tool>
          <Tool defaultOpen>
            <ToolHeader state="output-error" statusLabel={say('kubecode.proto.tool.failed')} title="launch_experiment" type="tool-launch_experiment" />
            <ToolContent>
              <ToolOutput errorLabel={say('kubecode.proto.tool.error')} errorText="CUDA out of memory at context 65536." output={undefined} />
            </ToolContent>
          </Tool>
          <Reasoning defaultOpen duration={4}>
            <ReasoningTrigger getThinkingMessage={(streaming, seconds) => (streaming
              ? say('kubecode.matrix.official.sample.thinking')
              : say('kubecode.matrix.official.sample.thoughtFor', { seconds: seconds ?? 1 }))}
            />
            <ReasoningContent>{'Compare the **64k** rows first; the tokenizer changed between runs.'}</ReasoningContent>
          </Reasoning>
          <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader>{say('kubecode.proto.activity')}</ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              <ChainOfThoughtStep description={say('kubecode.proto.step.complete')} label="Prepared configs for 9 runs" status="complete" />
              <ChainOfThoughtStep description={say('kubecode.proto.step.active')} label="Seed 1 at 64k" status="active" />
              <ChainOfThoughtStep description={say('kubecode.proto.step.pending')} label="Seeds 2 and 3" status="pending" />
            </ChainOfThoughtContent>
          </ChainOfThought>
          <Task>
            <TaskTrigger title={say('kubecode.proto.agents.plan', { count: 2 })} />
            <TaskContent>
              <TaskItem>Turing: run seeds 1–3</TaskItem>
              <TaskItem>Noether: compute recall@10</TaskItem>
            </TaskContent>
          </Task>
          <Plan defaultOpen>
            <PlanHeader>
              <div className="flex flex-col gap-1">
                <PlanTitle>{say('kubecode.proto.review.brief')}</PlanTitle>
                <PlanDescription>{say('kubecode.matrix.sample.longTitle')}</PlanDescription>
              </div>
              <PlanTrigger label={say('kubecode.proto.review.criteria')} />
            </PlanHeader>
            <PlanContent className="text-sm">{say('kubecode.matrix.official.sample.accordionBody')}</PlanContent>
          </Plan>
          <Queue>
            <QueueSection>
              <QueueSectionTrigger><QueueSectionLabel label={say('kubecode.proto.queue.running', { count: 1 })} /></QueueSectionTrigger>
              <QueueSectionContent>
                <QueueList>
                  <QueueItem>
                    <div className="flex items-center gap-2">
                      <QueueItemIndicator />
                      <QueueItemContent>Seed sweep · Turing</QueueItemContent>
                    </div>
                  </QueueItem>
                </QueueList>
              </QueueSectionContent>
            </QueueSection>
          </Queue>
          <Confirmation approval={{ id: 'sample' }} aria-label={say('kubecode.proto.decision.title', { name: 'Turing' })} role="region" state="approval-requested">
            <ConfirmationTitle>
              <strong className="block">{say('kubecode.proto.decision.title', { name: 'Turing' })}</strong>
              <ConfirmationRequest>
                <span className="block text-muted-foreground">{say('kubecode.proto.decision.scope')}</span>
              </ConfirmationRequest>
            </ConfirmationTitle>
            <ConfirmationActions>
              <ConfirmationAction variant="outline">{say('kubecode.proto.decision.decline')}</ConfirmationAction>
              <ConfirmationAction>{say('kubecode.proto.decision.allow')}</ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        </div>
      </Section>

      <Section title={say('kubecode.matrix.official.section.code')}>
        <CodeBlock className="max-w-3xl" code={SAMPLE_CODE} language="python">
          <CodeBlockCopyButton aria-label={say('kubecode.matrix.official.sample.copy')} />
        </CodeBlock>
      </Section>
    </div>
  )
}
