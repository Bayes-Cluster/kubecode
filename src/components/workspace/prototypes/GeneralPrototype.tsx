import { useState } from 'react'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationQuote,
  InlineCitationSource,
  InlineCitationText,
} from '@/components/ai-elements/inline-citation'
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { ViewHeader } from '../ViewHeader'
import { FIXTURE_MEMBERS, FIXTURE_REFERENCES, FIXTURE_REQUEST, FIXTURE_RESEARCH } from './fixtures'
import { Author, FixtureReference, type ScreenProps } from './shared'

/** Paper pages for the two cited papers; the notes are a Workspace file, not a URL. */
const PAPER_URLS = {
  longformer: 'https://arxiv.org/abs/2004.05150',
  bigbird: 'https://arxiv.org/abs/2007.14062',
} as const

function Citation({ index, quote, reference, t }: { index: number; quote: string; reference: keyof typeof PAPER_URLS; t: Translator }) {
  const source = FIXTURE_REFERENCES[reference]
  return (
    <InlineCitationCard>
      <InlineCitationCardTrigger aria-label={t('kubecode.proto.citation', { index, title: source.title })} sources={[PAPER_URLS[reference]]}>
        {index}
      </InlineCitationCardTrigger>
      <InlineCitationCardBody className="flex flex-col gap-2 p-3">
        <InlineCitationSource description={t('kubecode.proto.citationOpens')} title={source.title} url={PAPER_URLS[reference]} />
        <InlineCitationQuote>{quote}</InlineCitationQuote>
      </InlineCitationCardBody>
    </InlineCitationCard>
  )
}

function MessageTools({ t }: { t: Translator }) {
  return (
    <MessageActions aria-label={t('kubecode.proto.messageActions')} role="toolbar">
      <MessageAction label={t('kubecode.vocab.command.reply')} tooltip={t('kubecode.vocab.command.reply')}>
        <Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />
      </MessageAction>
      <MessageAction label={t('kubecode.vocab.command.copyLink')} tooltip={t('kubecode.vocab.command.copyLink')}>
        <Icon role="command" source={WORKSPACE_COMMAND_ICONS.copyLink.Icon} />
      </MessageAction>
      <MessageAction label={t('kubecode.vocab.command.share')} tooltip={t('kubecode.vocab.command.share')}>
        <Icon role="command" source={WORKSPACE_COMMAND_ICONS.share.Icon} />
      </MessageAction>
    </MessageActions>
  )
}

/** The reply as markdown, rendered by the hardened streamdown `MessageResponse`. */
function researchMarkdown(t: Translator): string {
  const header = [
    t('kubecode.proto.general.colMethod'),
    t('kubecode.proto.general.colContext'),
    t('kubecode.proto.general.colRecall'),
    t('kubecode.proto.general.colSource'),
  ]
  const rows = [header, header.map(() => '---'), ...FIXTURE_RESEARCH.table]
  return [
    FIXTURE_RESEARCH.intro,
    `### ${t('kubecode.proto.general.whatSourcesSay')}`,
    rows.map((row) => `| ${row.join(' | ')} |`).join('\n'),
    `### ${t('kubecode.proto.general.openQuestions')}`,
    FIXTURE_RESEARCH.openQuestions,
  ].join('\n\n')
}

function ResearchReply({ t }: { t: Translator }) {
  const [first, second, third] = FIXTURE_RESEARCH.findings
  return (
    <Message from="assistant">
      <Author member={FIXTURE_MEMBERS.general} time="10:42" />
      <MessageContent>
        <MessageResponse>{researchMarkdown(t)}</MessageResponse>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            <InlineCitation>
              <InlineCitationText>{first}</InlineCitationText>
              <Citation index={1} quote="Recall@10 0.89 at 32k for window 512 + 64 global tokens." reference="longformer" t={t} />
            </InlineCitation>
          </li>
          <li>
            <InlineCitation>
              <InlineCitationText>{second}</InlineCitationText>
              <Citation index={2} quote="Needle probes falling across block boundaries account for most misses." reference="bigbird" t={t} />
            </InlineCitation>
          </li>
          <li>{third}</li>
        </ul>
        <Sources>
          <SourcesTrigger count={3}>{t('kubecode.proto.sources', { count: 3 })}</SourcesTrigger>
          <SourcesContent>
            <Source href={PAPER_URLS.longformer} title={FIXTURE_REFERENCES.longformer.title} />
            <Source href={PAPER_URLS.bigbird} title={FIXTURE_REFERENCES.bigbird.title} />
            <FixtureReference
              kind="file"
              state={{ kind: 'changed', label: t('kubecode.proto.changedSinceCited') }}
              t={t}
              title={FIXTURE_REFERENCES.notes.title}
              version={FIXTURE_REFERENCES.notes.version}
            />
          </SourcesContent>
        </Sources>
      </MessageContent>
      <MessageTools t={t} />
    </Message>
  )
}

export function GeneralMain({ request, t }: Pick<ScreenProps, 'request' | 't'>) {
  const { state } = request
  const [draft, setDraft] = useState(state === 'busy' ? 'Add this comparison to the board as RQ-2.' : '')
  const [attached, setAttached] = useState(true)
  const [sent, setSent] = useState<string[]>([])
  const empty = state === 'empty'
  const busy = state === 'busy'

  return (
    <div className="kubecode-proto-conversation">
      <ViewHeader
        description={t('kubecode.proto.general.description')}
        icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />}
        level={1}
        title={t('kubecode.channel.general')}
      />
      <Conversation aria-label={t('kubecode.channel.general')} initial="instant">
        {empty ? (
          <ConversationEmptyState
            description={t('kubecode.proto.general.emptyDescription')}
            icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />}
            title={t('kubecode.proto.general.emptyTitle')}
          />
        ) : (
          <ConversationContent className="mx-auto w-full max-w-(--ws-conversation-width)">
            <Message from="user">
              <Author member={FIXTURE_MEMBERS.self} time="10:38" />
              <MessageContent>
                <MessageResponse>{FIXTURE_REQUEST}</MessageResponse>
                <div className="flex flex-wrap gap-1">
                  <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.notes.title} version={FIXTURE_REFERENCES.notes.version} />
                  <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.longformer.title} />
                  <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.bigbird.title} />
                </div>
              </MessageContent>
            </Message>
            <ResearchReply t={t} />
            <Message from="assistant">
              <Author member={FIXTURE_MEMBERS.ada} time="10:45" />
              <MessageContent>
                <MessageResponse>
                  I can extend the comparison with the 2024 follow-ups. That is new work, so it needs to go on the board first.
                </MessageResponse>
              </MessageContent>
            </Message>
            {state === 'error' && (
              <Message data-state="failed" from="user">
                <Author member={FIXTURE_MEMBERS.self} time="10:47" />
                <MessageContent>
                  <MessageResponse>@ada please start on the 2024 follow-ups.</MessageResponse>
                </MessageContent>
                <Alert role="alert" variant="destructive">
                  <AlertTitle>{t('kubecode.proto.notDelivered')}</AlertTitle>
                  <AlertDescription className="flex flex-wrap items-center gap-2">
                    <span>{t('kubecode.proto.notDeliveredHint')}</span>
                    <MessageAction label={t('kubecode.vocab.command.retry')} tooltip={t('kubecode.vocab.command.retry')}>
                      <Icon role="command" source={WORKSPACE_COMMAND_ICONS.retry.Icon} />
                    </MessageAction>
                  </AlertDescription>
                </Alert>
              </Message>
            )}
            {sent.map((text, index) => (
              <Message data-state="pending" from="user" key={`${index}-${text}`}>
                <Author member={FIXTURE_MEMBERS.self} time="10:50" />
                <MessageContent>
                  <MessageResponse>{text}</MessageResponse>
                  <Badge variant="outline">{t('kubecode.proto.fixtureNotSent')}</Badge>
                </MessageContent>
              </Message>
            ))}
            {busy && (
              <Message data-state="pending" from="assistant">
                <Author activity={<Shimmer as="span">{t('kubecode.proto.writing')}</Shimmer>} member={FIXTURE_MEMBERS.general} time="10:48" />
                <MessageContent>
                  <Spinner aria-label={t('kubecode.proto.writing')} />
                </MessageContent>
              </Message>
            )}
          </ConversationContent>
        )}
        <ConversationScrollButton aria-label={t('kubecode.vocab.command.latest')} />
      </Conversation>
      <div className="kubecode-proto-dock mx-auto w-full max-w-(--ws-composer-width)">
        {!empty && (
          <div aria-label={t('kubecode.proto.suggestions')} role="group">
            <Suggestions>
              {[
                t('kubecode.proto.suggest.board'),
                t('kubecode.proto.suggest.ask'),
                t('kubecode.proto.suggest.summarize'),
              ].map((text) => <Suggestion key={text} suggestion={text} onClick={setDraft} />)}
            </Suggestions>
          </div>
        )}
        <PromptInput
          onSubmit={({ text }) => {
            if (!text.trim()) return
            setSent((previous) => [...previous, text])
            setDraft('')
          }}
        >
          {attached && (
            <PromptInputHeader>
              <FixtureReference
                kind="file"
                removeLabel={t('kubecode.proto.removeReference', { title: FIXTURE_REFERENCES.notes.title })}
                t={t}
                title={FIXTURE_REFERENCES.notes.title}
                version={FIXTURE_REFERENCES.notes.version}
                onRemove={() => setAttached(false)}
              />
            </PromptInputHeader>
          )}
          <PromptInputBody>
            <PromptInputTextarea
              aria-label={t('kubecode.proto.composerLabel')}
              placeholder={t('kubecode.channel.composerPlaceholder')}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputButton aria-label={t('kubecode.vocab.command.addContext')} onClick={() => setAttached(true)}>
                <Icon role="command" source={WORKSPACE_COMMAND_ICONS.addContext.Icon} />
              </PromptInputButton>
            </PromptInputTools>
            <PromptInputSubmit
              aria-label={busy ? t('kubecode.proto.sending') : t('kubecode.channel.send')}
              disabled={!draft.trim() || busy}
              status={busy ? 'submitted' : undefined}
            />
          </PromptInputFooter>
        </PromptInput>
        <p className="kubecode-proto-note">{t('kubecode.proto.publicHint')}</p>
      </div>
    </div>
  )
}

export function Materials({ t }: { t: Translator }) {
  return (
    <div className="kubecode-proto-inspector-body">
      <ViewHeader description={t('kubecode.proto.materialsDescription')} level={2} title={t('kubecode.proto.materials')} />
      <ItemGroup className="gap-1">
        <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.notes.title} version={FIXTURE_REFERENCES.notes.version} />
        <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.longformer.title} />
        <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.bigbird.title} />
        <FixtureReference kind="finding" t={t} title={FIXTURE_REFERENCES.finding.title} version={FIXTURE_REFERENCES.finding.version} />
        <Item size="sm" variant="muted">
          <ItemContent>
            <ItemTitle>{FIXTURE_REFERENCES.dmNotes.title}</ItemTitle>
            <ItemDescription>{t('kubecode.proto.privateDm')}</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
      <p className="kubecode-proto-note">{t('kubecode.proto.dmRule')}</p>
    </div>
  )
}
