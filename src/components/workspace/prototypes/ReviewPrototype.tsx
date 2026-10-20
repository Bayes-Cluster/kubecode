import { useState } from 'react'

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  ConversationEmptyState,
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
  InlineCitationText,
  MessageResponse,
} from '@/components/ai-elements'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { Composer } from '../Composer'
import { DecisionButton } from '../DecisionButton'
import { MemberIdentity } from '../MemberIdentity'
import { StatusBadge } from '../StatusBadge'
import { ViewHeader } from '../ViewHeader'
import { FIXTURE_MEMBERS, FIXTURE_REFERENCES, FIXTURE_REVIEW, FIXTURE_TASK_TITLE } from './fixtures'
import { FixtureReference, type ScreenProps } from './shared'

type Outcome = 'open' | 'accepted' | 'sendingBack' | 'sentBack'

export function ReviewMain({ go, request, t }: ScreenProps) {
  const { state } = request
  const [outcome, setOutcome] = useState<Outcome>('open')
  const [reason, setReason] = useState('')
  const empty = state === 'empty'
  const changed = state === 'error'
  const fromLabel = request.from === 'agents' ? t('kubecode.vocab.destination.needsYou') : t('kubecode.channel.general')
  const acceptBlocked = empty
    ? t('kubecode.proto.review.nothingToAccept')
    : changed ? t('kubecode.task.evidenceStale') : undefined

  return (
    <div className="kubecode-proto-review">
      <ViewHeader
        back={{ label: t('kubecode.proto.backTo', { place: fromLabel }), onBack: () => go({ screen: request.from, state: 'default' }) }}
        icon={<Icon role="navigation" source={WORKSPACE_OBJECT_ICONS.task.Icon} />}
        level={1}
        meta={(
          <>
            <StatusBadge tone={outcome === 'accepted' ? 'ok' : 'warn'}>
              {outcome === 'accepted' ? t('kubecode.proto.review.accepted') : t('kubecode.proto.review.waiting')}
            </StatusBadge>
            <MemberIdentity name={FIXTURE_MEMBERS.general.name} role="manager" roleLabel={t('kubecode.proto.review.requestedBy')} size="sm" />
          </>
        )}
        title={FIXTURE_TASK_TITLE}
      />
      <Tabs className="kubecode-proto-tabs" defaultValue="results">
        <TabsList aria-label={t('kubecode.task.tabs')}>
          <TabsTrigger value="overview">{t('kubecode.task.tab.overview')}</TabsTrigger>
          <TabsTrigger value="results">{t('kubecode.task.tab.results')}</TabsTrigger>
          <TabsTrigger value="activity">{t('kubecode.task.tab.activity')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <MessageResponse>
            <h3>{t('kubecode.proto.review.brief')}</h3>
            <p>{FIXTURE_REVIEW.brief}</p>
            <h3>{t('kubecode.proto.review.criteria')}</h3>
            <ul>{FIXTURE_REVIEW.criteria.map((item) => <li key={item}>{item}</li>)}</ul>
          </MessageResponse>
        </TabsContent>
        <TabsContent value="results">
          {empty ? (
            <ConversationEmptyState description={t('kubecode.proto.review.emptyDescription')} title={t('kubecode.proto.review.emptyTitle')} />
          ) : (
            <div className="kubecode-proto-results">
              <MessageResponse>
                <p>
                  <InlineCitation>
                    <InlineCitationText>{FIXTURE_REVIEW.summary}</InlineCitationText>
                    <InlineCitationCard>
                      <InlineCitationCardTrigger index="1" label={t('kubecode.proto.citation', { index: 1, title: FIXTURE_REFERENCES.recallTable.title })} />
                      <InlineCitationCardBody align="start">
                        <InlineCitationSource description={t('kubecode.proto.citationOpens')}>
                          <FixtureReference kind="evidence" t={t} title={FIXTURE_REFERENCES.recallTable.title} version={FIXTURE_REFERENCES.recallTable.version} />
                        </InlineCitationSource>
                      </InlineCitationCardBody>
                    </InlineCitationCard>
                  </InlineCitation>
                </p>
              </MessageResponse>
              <h3 className="kubecode-proto-subheading">{t('kubecode.proto.review.evidence')}</h3>
              <ul className="kubecode-proto-list">
                <li>
                  <FixtureReference
                    kind="evidence"
                    state={changed ? { kind: 'changed', label: t('kubecode.proto.review.changedTo', { version: 'v4' }) } : undefined}
                    t={t}
                    title={FIXTURE_REFERENCES.recallTable.title}
                    version={FIXTURE_REFERENCES.recallTable.version}
                  />
                </li>
                <li><FixtureReference kind="evidence" t={t} title={FIXTURE_REFERENCES.ablation.title} version={FIXTURE_REFERENCES.ablation.version} /></li>
                <li><FixtureReference kind="artifact" t={t} title={FIXTURE_REFERENCES.runLog.title} /></li>
              </ul>
            </div>
          )}
        </TabsContent>
        <TabsContent value="activity">
          <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader>{t('kubecode.task.activity.history')}</ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              <ChainOfThoughtStep label={t('kubecode.task.activity.admitted')} status="complete" statusLabel="10:52" />
              <ChainOfThoughtStep label={t('kubecode.task.activity.execution_authorized')} status="complete" statusLabel="11:02" />
              <ChainOfThoughtStep label={t('kubecode.task.activity.review_requested', { actor: FIXTURE_MEMBERS.general.name })} status="active" statusLabel="12:40" />
            </ChainOfThoughtContent>
          </ChainOfThought>
        </TabsContent>
      </Tabs>
      <section aria-label={t('kubecode.proto.review.decision')} className="kubecode-proto-decision">
        {outcome === 'accepted' ? (
          <p role="status">{t('kubecode.proto.review.acceptedFixture')}</p>
        ) : outcome === 'sentBack' ? (
          <p role="status">{t('kubecode.proto.review.sentBackFixture')}</p>
        ) : (
          <>
            <p className="kubecode-proto-note">{t('kubecode.proto.review.acceptsShown')}</p>
            {outcome === 'sendingBack' && (
              <Composer
                label={t('kubecode.proto.review.reasonLabel')}
                placeholder={t('kubecode.proto.review.reasonPlaceholder')}
                rows={2}
                sendLabel={t('kubecode.task.sendBack')}
                value={reason}
                onChange={setReason}
                onSend={() => setOutcome('sentBack')}
              />
            )}
            <div className="kubecode-proto-decision-actions">
              {outcome !== 'sendingBack' && (
                <DecisionButton variant="secondary" onDecide={() => setOutcome('sendingBack')}>{t('kubecode.task.sendBack')}</DecisionButton>
              )}
              <DecisionButton busy={state === 'busy'} disabledReason={acceptBlocked} variant="primary" onDecide={() => setOutcome('accepted')}>
                {t('kubecode.task.acceptResults')}
              </DecisionButton>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

export function EvidenceDetail({ state, t }: { state: ScreenProps['request']['state']; t: Translator }) {
  if (state === 'empty') {
    return (
      <div className="kubecode-proto-inspector-body">
        <ViewHeader level={2} title={t('kubecode.proto.review.evidence')} />
        <p className="kubecode-proto-note">{t('kubecode.proto.review.emptyDescription')}</p>
      </div>
    )
  }
  return (
    <div className="kubecode-proto-inspector-body">
      <ViewHeader
        description={t('kubecode.proto.review.shownVersion', { version: FIXTURE_REFERENCES.recallTable.version })}
        level={2}
        title={FIXTURE_REFERENCES.recallTable.title}
      />
      <div className="kubecode-ai-response">
        <div aria-label={FIXTURE_REFERENCES.recallTable.title} className="kubecode-ai-table-wrap" role="region" tabIndex={0}>
          <table>
            <thead>
              <tr><th scope="col">{t('kubecode.proto.general.colContext')}</th><th scope="col">Dense</th><th scope="col">Window + global</th></tr>
            </thead>
            <tbody>
              <tr><td>16k</td><td>0.912</td><td>0.905</td></tr>
              <tr><td>32k</td><td>0.909</td><td>0.893</td></tr>
              <tr><td>64k</td><td>0.904</td><td>0.880</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <h3 className="kubecode-proto-subheading">{t('kubecode.proto.review.versions')}</h3>
      <ol className="kubecode-proto-versions">
        {state === 'error' && <li><strong>v4</strong> · {t('kubecode.proto.review.newerVersion')}</li>}
        <li><strong>v3</strong> · {t('kubecode.proto.review.shown')}</li>
        <li><strong>v2</strong> · {t('kubecode.proto.review.olderVersion')}</li>
      </ol>
    </div>
  )
}
