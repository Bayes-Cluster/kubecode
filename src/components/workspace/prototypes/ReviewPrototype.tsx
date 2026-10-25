import { useId, useState } from 'react'

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought'
import { Checkpoint, CheckpointIcon } from '@/components/ai-elements/checkpoint'
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
  InlineCitationText,
} from '@/components/ai-elements/inline-citation'
import { MessageResponse } from '@/components/ai-elements/message'
import { Plan, PlanContent, PlanDescription, PlanHeader, PlanTitle, PlanTrigger } from '@/components/ai-elements/plan'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { ItemGroup } from '@/components/ui/item'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_OBJECT_ICONS } from '@/kubecode/icons/workspaceIcons'
import type { Translator } from '@/lib/i18n'

import { ViewHeader } from '../ViewHeader'
import { FIXTURE_MEMBERS, FIXTURE_REFERENCES, FIXTURE_REVIEW, FIXTURE_TASK_TITLE } from './fixtures'
import { FixtureReference, type ScreenProps } from './shared'

type Outcome = 'open' | 'accepted' | 'sendingBack' | 'sentBack'

export function ReviewMain({ go, request, t }: ScreenProps) {
  const { state } = request
  const [outcome, setOutcome] = useState<Outcome>('open')
  const [reason, setReason] = useState('')
  const reasonId = useId()
  const blockedId = useId()
  const empty = state === 'empty'
  const changed = state === 'error'
  const fromLabel = request.from === 'agents' ? t('kubecode.vocab.destination.needsYou') : t('kubecode.channel.general')
  const acceptBlocked = empty
    ? t('kubecode.proto.review.nothingToAccept')
    : changed ? t('kubecode.task.evidenceStale') : undefined

  return (
    <div className="kubecode-proto-review">
      <ViewHeader
        className="px-(--ws-space-5) py-(--ws-space-3) max-md:p-(--ws-space-3)"
        back={{ label: t('kubecode.proto.backTo', { place: fromLabel }), onBack: () => go({ screen: request.from, state: 'default' }) }}
        icon={<Icon role="navigation" source={WORKSPACE_OBJECT_ICONS.task.Icon} />}
        level={1}
        meta={(
          <>
            <Badge variant={outcome === 'accepted' ? 'default' : 'secondary'}>
              {outcome === 'accepted' ? t('kubecode.proto.review.accepted') : t('kubecode.proto.review.waiting')}
            </Badge>
            <Badge variant="outline">{t('kubecode.proto.review.requestedBy')} · {FIXTURE_MEMBERS.general.name}</Badge>
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
          <Plan defaultOpen>
            <PlanHeader>
              <div className="flex flex-col gap-1">
                <PlanTitle>{t('kubecode.proto.review.brief')}</PlanTitle>
                <PlanDescription>{FIXTURE_REVIEW.brief}</PlanDescription>
              </div>
              <PlanTrigger label={t('kubecode.proto.review.criteria')} />
            </PlanHeader>
            <PlanContent>
              <h3 className="mb-2 font-medium text-sm">{t('kubecode.proto.review.criteria')}</h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {FIXTURE_REVIEW.criteria.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </PlanContent>
          </Plan>
        </TabsContent>
        <TabsContent value="results">
          {empty ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('kubecode.proto.review.emptyTitle')}</EmptyTitle>
                <EmptyDescription>{t('kubecode.proto.review.emptyDescription')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="kubecode-proto-results">
              <p className="text-sm">
                <InlineCitation>
                  <InlineCitationText>{FIXTURE_REVIEW.summary}</InlineCitationText>
                  <InlineCitationCard>
                    <InlineCitationCardTrigger
                      aria-label={t('kubecode.proto.citation', { index: 1, title: FIXTURE_REFERENCES.recallTable.title })}
                      sources={[]}
                    >
                      1
                    </InlineCitationCardTrigger>
                    <InlineCitationCardBody className="p-3">
                      <InlineCitationSource description={t('kubecode.proto.citationOpens')} title={FIXTURE_REFERENCES.recallTable.title} />
                    </InlineCitationCardBody>
                  </InlineCitationCard>
                </InlineCitation>
              </p>
              <h3 className="kubecode-proto-subheading">{t('kubecode.proto.review.evidence')}</h3>
              <ItemGroup className="gap-1">
                <FixtureReference
                  kind="evidence"
                  state={changed ? { kind: 'changed', label: t('kubecode.proto.review.changedTo', { version: 'v4' }) } : undefined}
                  t={t}
                  title={FIXTURE_REFERENCES.recallTable.title}
                  version={FIXTURE_REFERENCES.recallTable.version}
                />
                <FixtureReference kind="evidence" t={t} title={FIXTURE_REFERENCES.ablation.title} version={FIXTURE_REFERENCES.ablation.version} />
                <FixtureReference kind="artifact" t={t} title={FIXTURE_REFERENCES.runLog.title} />
              </ItemGroup>
            </div>
          )}
        </TabsContent>
        <TabsContent value="activity">
          <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader>{t('kubecode.task.activity.history')}</ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              <ChainOfThoughtStep description="10:52" label={t('kubecode.task.activity.admitted')} status="complete" />
              <ChainOfThoughtStep description="11:02" label={t('kubecode.task.activity.execution_authorized')} status="complete" />
              <ChainOfThoughtStep description="12:40" label={t('kubecode.task.activity.review_requested', { actor: FIXTURE_MEMBERS.general.name })} status="active" />
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
              <Field>
                <FieldLabel htmlFor={reasonId}>{t('kubecode.proto.review.reasonLabel')}</FieldLabel>
                <Textarea
                  id={reasonId}
                  placeholder={t('kubecode.proto.review.reasonPlaceholder')}
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.currentTarget.value)}
                />
              </Field>
            )}
            {acceptBlocked && <FieldDescription id={blockedId}>{acceptBlocked}</FieldDescription>}
            <div className="kubecode-proto-decision-actions">
              <Button
                variant="outline"
                onClick={() => setOutcome(outcome === 'sendingBack' ? 'sentBack' : 'sendingBack')}
              >
                {t('kubecode.task.sendBack')}
              </Button>
              {outcome !== 'sendingBack' && (
                <Button
                  aria-describedby={acceptBlocked ? blockedId : undefined}
                  disabled={Boolean(acceptBlocked) || state === 'busy'}
                  onClick={() => setOutcome('accepted')}
                >
                  {t('kubecode.task.acceptResults')}
                </Button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/** The evidence table, as hardened streamdown markdown. */
function recallTable(t: Translator): string {
  return [
    `| ${t('kubecode.proto.general.colContext')} | Dense | Window + global |`,
    '| --- | --- | --- |',
    '| 16k | 0.912 | 0.905 |',
    '| 32k | 0.909 | 0.893 |',
    '| 64k | 0.904 | 0.880 |',
  ].join('\n')
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
  const versions = [
    ...(state === 'error' ? [{ version: 'v4', note: t('kubecode.proto.review.newerVersion') }] : []),
    { version: 'v3', note: t('kubecode.proto.review.shown') },
    { version: 'v2', note: t('kubecode.proto.review.olderVersion') },
  ]
  return (
    <div className="kubecode-proto-inspector-body">
      <ViewHeader
        description={t('kubecode.proto.review.shownVersion', { version: FIXTURE_REFERENCES.recallTable.version })}
        level={2}
        title={FIXTURE_REFERENCES.recallTable.title}
      />
      <MessageResponse>{recallTable(t)}</MessageResponse>
      <h3 className="kubecode-proto-subheading">{t('kubecode.proto.review.versions')}</h3>
      <ol className="flex flex-col gap-1">
        {versions.map(({ note, version }) => (
          <li key={version}>
            <Checkpoint className="text-muted-foreground text-sm">
              <CheckpointIcon />
              <span><strong className="text-foreground">{version}</strong> · {note}</span>
            </Checkpoint>
          </li>
        ))}
      </ol>
    </div>
  )
}
