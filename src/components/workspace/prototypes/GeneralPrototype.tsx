import { useState } from 'react'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationQuote,
  InlineCitationSource,
  InlineCitationText,
  Loader,
  Message,
  MessageActions,
  MessageContent,
  MessageResponse,
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  Shimmer,
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
  Suggestion,
  Suggestions,
} from '@/components/ai-elements'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS, WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { Composer } from '../Composer'
import { IconButton } from '../IconButton'
import { MoreActions } from '../MoreActions'
import { StatusBadge } from '../StatusBadge'
import { ViewHeader } from '../ViewHeader'
import { FIXTURE_MEMBERS, FIXTURE_MENTIONS, FIXTURE_REFERENCES, FIXTURE_REQUEST, FIXTURE_RESEARCH } from './fixtures'
import { Author, FixtureReference, type ScreenProps } from './shared'

function Citation({ index, quote, reference, t }: { index: number; quote: string; reference: keyof typeof FIXTURE_REFERENCES; t: Translator }) {
  const source = FIXTURE_REFERENCES[reference]
  return (
    <InlineCitationCard>
      <InlineCitationCardTrigger index={String(index)} label={t('kubecode.proto.citation', { index, title: source.title })} />
      <InlineCitationCardBody align="start">
        <InlineCitationSource description={t('kubecode.proto.citationOpens')}>
          <FixtureReference kind={source.kind} t={t} title={source.title} version={'version' in source ? source.version : undefined} />
        </InlineCitationSource>
        <InlineCitationQuote>{quote}</InlineCitationQuote>
      </InlineCitationCardBody>
    </InlineCitationCard>
  )
}

function MessageTools({ t }: { t: Translator }) {
  return (
    <MessageActions label={t('kubecode.proto.messageActions')}>
      <IconButton icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />} label={t('kubecode.vocab.command.reply')} />
      <IconButton icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.copyLink.Icon} />} label={t('kubecode.vocab.command.copyLink')} />
      <MoreActions
        items={[{ id: 'share', label: t('kubecode.vocab.command.share'), onSelect: () => undefined }]}
        label={t('kubecode.vocab.command.more')}
      />
    </MessageActions>
  )
}

function ResearchReply({ t }: { t: Translator }) {
  const [first, second, third] = FIXTURE_RESEARCH.findings
  return (
    <Message author={<Author member={FIXTURE_MEMBERS.general} time="10:42" />} from="member">
      <MessageContent>
        <MessageResponse>
          <p>{FIXTURE_RESEARCH.intro}</p>
          <h3>{t('kubecode.proto.general.whatSourcesSay')}</h3>
          <ul>
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
            <li>
              <InlineCitation>
                <InlineCitationText>{third}</InlineCitationText>
                <Citation index={3} quote="64k windowed: recall@10 = 0.80 (dense 0.89)." reference="notes" t={t} />
              </InlineCitation>
            </li>
          </ul>
          <div className="kubecode-ai-table-wrap" role="region" aria-label={t('kubecode.proto.general.tableLabel')} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('kubecode.proto.general.colMethod')}</th>
                  <th scope="col">{t('kubecode.proto.general.colContext')}</th>
                  <th scope="col">{t('kubecode.proto.general.colRecall')}</th>
                  <th scope="col">{t('kubecode.proto.general.colSource')}</th>
                </tr>
              </thead>
              <tbody>
                {FIXTURE_RESEARCH.table.map((row) => (
                  <tr key={row.join('|')}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t('kubecode.proto.general.openQuestions')}</h3>
          <p>{FIXTURE_RESEARCH.openQuestions}</p>
        </MessageResponse>
        <Sources>
          <SourcesTrigger label={t('kubecode.proto.sources', { count: 3 })} />
          <SourcesContent>
            <Source><FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.longformer.title} /></Source>
            <Source><FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.bigbird.title} /></Source>
            <Source>
              <FixtureReference
                kind="file"
                state={{ kind: 'changed', label: t('kubecode.proto.changedSinceCited') }}
                t={t}
                title={FIXTURE_REFERENCES.notes.title}
                version={FIXTURE_REFERENCES.notes.version}
              />
            </Source>
          </SourcesContent>
        </Sources>
        <MessageTools t={t} />
      </MessageContent>
    </Message>
  )
}

export function GeneralMain({ request, t }: Pick<ScreenProps, 'request' | 't'>) {
  const { state } = request
  const [draft, setDraft] = useState(state === 'busy' ? 'Add this comparison to the board as RQ-2.' : '')
  const [attached, setAttached] = useState(true)
  const [sent, setSent] = useState<string[]>([])
  const empty = state === 'empty'

  return (
    <div className="kubecode-proto-conversation">
      <ViewHeader
        description={t('kubecode.proto.general.description')}
        icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />}
        level={1}
        title={t('kubecode.channel.general')}
      />
      <Conversation initial="end" label={t('kubecode.channel.general')}>
        {empty ? (
          <ConversationEmptyState
            description={t('kubecode.proto.general.emptyDescription')}
            icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />}
            title={t('kubecode.proto.general.emptyTitle')}
          />
        ) : (
          <ConversationContent>
            <Message author={<Author member={FIXTURE_MEMBERS.self} time="10:38" />} from="self">
              <MessageContent>
                <MessageResponse><p>{FIXTURE_REQUEST}</p></MessageResponse>
                <div className="kubecode-proto-chips">
                  <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.notes.title} version={FIXTURE_REFERENCES.notes.version} />
                  <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.longformer.title} />
                  <FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.bigbird.title} />
                </div>
              </MessageContent>
            </Message>
            <ResearchReply t={t} />
            <Message author={<Author member={FIXTURE_MEMBERS.ada} time="10:45" />} from="member">
              <MessageContent>
                <MessageResponse>
                  <p>I can extend the comparison with the 2024 follow-ups. That is new work, so it needs to go on the board first.</p>
                </MessageResponse>
              </MessageContent>
            </Message>
            {state === 'error' && (
              <Message author={<Author member={FIXTURE_MEMBERS.self} time="10:47" />} from="self" state="failed">
                <MessageContent>
                  <MessageResponse><p>@ada please start on the 2024 follow-ups.</p></MessageResponse>
                  <p className="kubecode-proto-delivery" role="alert">
                    <StatusBadge tone="danger">{t('kubecode.proto.notDelivered')}</StatusBadge>
                    <span>{t('kubecode.proto.notDeliveredHint')}</span>
                    <IconButton icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.retry.Icon} />} label={t('kubecode.vocab.command.retry')} />
                  </p>
                </MessageContent>
              </Message>
            )}
            {sent.map((text, index) => (
              <Message author={<Author member={FIXTURE_MEMBERS.self} time="10:50" />} from="self" key={`${index}-${text}`} state="pending">
                <MessageContent>
                  <MessageResponse><p>{text}</p></MessageResponse>
                  <p className="kubecode-proto-delivery"><StatusBadge tone="muted">{t('kubecode.proto.fixtureNotSent')}</StatusBadge></p>
                </MessageContent>
              </Message>
            ))}
            {state === 'busy' && (
              <Message author={<Author activity={<Shimmer>{t('kubecode.proto.writing')}</Shimmer>} member={FIXTURE_MEMBERS.general} time="10:48" />} from="member" state="pending">
                <MessageContent>
                  <Loader label={t('kubecode.proto.writing')} />
                </MessageContent>
              </Message>
            )}
          </ConversationContent>
        )}
        <ConversationScrollButton label={t('kubecode.vocab.command.latest')} />
      </Conversation>
      <div className="kubecode-proto-dock">
        {!empty && (
          <Suggestions label={t('kubecode.proto.suggestions')}>
            {[
              t('kubecode.proto.suggest.board'),
              t('kubecode.proto.suggest.ask'),
              t('kubecode.proto.suggest.summarize'),
            ].map((text) => <Suggestion key={text} suggestion={text} onClick={setDraft} />)}
          </Suggestions>
        )}
        <PromptInput busy={state === 'busy'}>
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
            <Composer
              busy={state === 'busy'}
              busyLabel={t('kubecode.proto.sending')}
              controls={(
                <IconButton
                  icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.addContext.Icon} />}
                  label={t('kubecode.vocab.command.addContext')}
                  onClick={() => setAttached(true)}
                />
              )}
              label={t('kubecode.proto.composerLabel')}
              mentionLabel={t('kubecode.vocab.command.mention')}
              mentions={FIXTURE_MENTIONS}
              placeholder={t('kubecode.channel.composerPlaceholder')}
              rows={2}
              sendLabel={t('kubecode.channel.send')}
              value={draft}
              onChange={setDraft}
              onSend={() => {
                setSent((previous) => [...previous, draft])
                setDraft('')
              }}
            />
          </PromptInputBody>
          <PromptInputFooter>{t('kubecode.proto.publicHint')}</PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

export function Materials({ t }: { t: Translator }) {
  return (
    <div className="kubecode-proto-inspector-body">
      <ViewHeader description={t('kubecode.proto.materialsDescription')} level={2} title={t('kubecode.proto.materials')} />
      <ul className="kubecode-proto-list">
        <li><FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.notes.title} version={FIXTURE_REFERENCES.notes.version} /></li>
        <li><FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.longformer.title} /></li>
        <li><FixtureReference kind="file" t={t} title={FIXTURE_REFERENCES.bigbird.title} /></li>
        <li><FixtureReference kind="finding" t={t} title={FIXTURE_REFERENCES.finding.title} version={FIXTURE_REFERENCES.finding.version} /></li>
        <li>
          <FixtureReference
            kind="discussion"
            state={{ kind: 'unavailable', label: t('kubecode.proto.privateDm') }}
            t={t}
            title={FIXTURE_REFERENCES.dmNotes.title}
          />
        </li>
      </ul>
      <p className="kubecode-proto-note">{t('kubecode.proto.dmRule')}</p>
    </div>
  )
}
