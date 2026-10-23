import { type ReactNode, useState } from 'react'

import { Plan, PlanContent } from '@/components/ai-elements/plan'
import { Task, TaskContent, TaskItem } from '@/components/ai-elements/task'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { MemberIdentity } from '@/components/workspace/MemberIdentity'
import type { Translator } from '@/lib/i18n'

import type { ResearchBrief, TaskDetail } from '../api'
import { useInspectorEntry, useInspectorServices } from '../app/inspector/inspectorContext'
import { ResearchBriefPanel } from '../research/ResearchBriefPanel'
import type { ResearchBundle } from '../research/useResearch'
import { ReaderEmpty, ReaderNotice } from '../resources/ReaderStates'
import { conditionLabel } from './taskLabels'
import { hasOpenReview, progressOf } from './taskLifecycle'
import { useGeneralFromTask } from './taskNavigation'
import { TaskQuestions } from './TaskQuestions'
import { StatusBadge } from '@/components/workspace/StatusBadge'

export type TaskOverviewProps = {
  /** An admitted Task; null for a proposal, which shows only its goal. */
  detail: TaskDetail | null
  bundle: ResearchBundle | null
  projectId: string
  /** The brief editor is shown instead of the goal. */
  editing: boolean
  onEdit: () => void
  onEditDone: () => void
  onChanged: () => void
  onBundleChanged: () => void
  onOpenResults: () => void
  onDiscuss: () => void
}

/**
 * What a Task is and what it needs (ADR 0230 §3): what waits on the
 * researcher, the goal, who authorized it in General, who works on it, and
 * how far the work is.
 */
export function TaskOverview({
  bundle,
  detail,
  editing,
  onBundleChanged,
  onChanged,
  onDiscuss,
  onEdit,
  onEditDone,
  onOpenResults,
  projectId,
}: TaskOverviewProps) {
  const { api, t } = useInspectorServices()
  const [edited, setEdited] = useState(false)
  const brief = detail?.brief ?? bundle?.detail.brief ?? null
  const archived = detail ? Boolean(detail.archived) : Boolean(bundle?.detail.archived)
  const review = hasOpenReview(detail)
  const questions = (detail?.open_questions.length ?? 0) > 0
  const approval = detail !== null && detail.revision > detail.approved_revision
  const suggestions = detail?.pending?.some((item) => item.kind === 'suggestion') ?? false
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {detail && (review || questions || approval || suggestions) && (
        <section aria-label={t('kubecode.task.waitingOnYou')} className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">{t('kubecode.task.waitingOnYou')}</h4>
          {review && (
            <Waiting action={<Button className="pointer-coarse:min-h-11" size="xs" variant="outline" onClick={onOpenResults}>{t('kubecode.task.openResults')}</Button>}>
              {t('kubecode.task.reviewReady')}
            </Waiting>
          )}
          {questions && <TaskQuestions detail={detail} projectId={projectId} onChanged={onChanged} />}
          {suggestions && (
            <Waiting action={<Button className="pointer-coarse:min-h-11" size="xs" variant="outline" onClick={onOpenResults}>{t('kubecode.task.goToResults')}</Button>}>
              {t('kubecode.task.suggestionsWaiting')}
            </Waiting>
          )}
          {approval && (
            <Waiting
              action={<Button className="pointer-coarse:min-h-11" size="xs" variant="outline" onClick={onDiscuss}>{t('kubecode.task.discuss')}</Button>}
              focusKey={`brief:${detail.id}:${detail.revision}`}
            >
              {t('kubecode.task.staleApproval', { approved: detail.approved_revision })}
            </Waiting>
          )}
        </section>
      )}

      <section aria-label={t('kubecode.task.goal')} className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('kubecode.task.goal')}</h4>
        {editing && bundle ? (
          <ResearchBriefPanel
            api={api}
            detail={bundle.detail}
            startEditing
            t={t}
            onChanged={() => {
              setEdited(true)
              onBundleChanged()
              onChanged()
            }}
            onDone={onEditDone}
          />
        ) : (
          <>
            {brief && <BriefSummary brief={brief} t={t} />}
            <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              {detail
                ? t('kubecode.task.workingRevision', { approved: detail.approved_revision })
                : bundle ? t('kubecode.task.revision', { revision: bundle.detail.revision }) : null}
              {!archived && (
                <Button disabled={editing} className="pointer-coarse:min-h-11" size="xs" variant="ghost" onClick={onEdit}>{t('kubecode.research.editBrief')}</Button>
              )}
            </p>
            {edited && detail && detail.revision > detail.approved_revision && (
              <ReaderNotice>
                {t('kubecode.task.briefEditedNotice', { revision: detail.revision, approved: detail.approved_revision })}
              </ReaderNotice>
            )}
          </>
        )}
      </section>

      {detail && <Provenance detail={detail} t={t} />}
      {detail && <People detail={detail} t={t} />}
      {detail && <Progress detail={detail} t={t} />}
    </div>
  )
}

/** One thing waiting on the researcher, with the step that answers it: an official Item. */
function Waiting({ action, children, focusKey }: { action: ReactNode; children: ReactNode; focusKey?: string }) {
  return (
    <Item data-focus-key={focusKey} size="sm" tabIndex={focusKey ? -1 : undefined} variant="outline">
      <ItemContent>
        <ItemTitle className="font-normal">{children}</ItemTitle>
      </ItemContent>
      <ItemActions>{action}</ItemActions>
    </Item>
  )
}

function BriefSummary({ brief, t }: { brief: ResearchBrief; t: Translator }) {
  const lists: Array<[string, string[]]> = [
    [t('kubecode.task.hypotheses'), brief.hypotheses],
    [t('kubecode.task.criteria'), brief.evaluation_criteria],
    [t('kubecode.task.constraints'), brief.constraints],
  ]
  // The brief is the Task's plan (ADR 0243): always open, its labels kept as one description list.
  return (
    <Plan className="py-4" open>
      <PlanContent className="px-4">
        <dl className="flex flex-col gap-3 text-sm">
          {/* Every section is one group, so labels and lists line up (#229). */}
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t('kubecode.task.question')}</dt>
            <dd className="[overflow-wrap:anywhere]">{brief.question}</dd>
          </div>
          {lists.filter(([, items]) => items.length > 0).map(([label, items]) => (
            <div className="flex flex-col gap-1" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <ul className="flex list-disc flex-col gap-1 pl-5 [overflow-wrap:anywhere]">
                  {items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      </PlanContent>
    </Plan>
  )
}

function Provenance({ detail, t }: { detail: TaskDetail; t: Translator }) {
  const general = useGeneralFromTask()
  const message = detail.authorizing_message
  if (detail.origin === 'legacy_round' || !message) {
    return <p className="text-sm text-muted-foreground">{t('kubecode.task.legacyOrigin')}</p>
  }
  // Who authorized the Task, in their own words, and the way to the message in General.
  return (
    <Item size="sm" variant="muted">
      <ItemContent>
        <ItemDescription className="line-clamp-none">{t('kubecode.task.addedBy')}</ItemDescription>
        <ItemTitle className="font-normal [overflow-wrap:anywhere]"><q>{message.body}</q></ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button
          className="pointer-coarse:min-h-11"
          size="xs"
          variant="ghost"
          // Narrowed to the Task when the message is in its scope; otherwise all of General.
          onClick={() => general({ message: message.id, filter: message.task_id === detail.id ? detail.id : null })}
        >
          {t('kubecode.task.showMessage')}
        </Button>
      </ItemActions>
    </Item>
  )
}

function People({ detail, t }: { detail: TaskDetail; t: Translator }) {
  const { push } = useInspectorEntry()
  const manager = detail.participants.filter((member) => member.role === 'general')
  const specialists = detail.participants.filter((member) => member.role !== 'general')
  const open = (memberId: string) => push({ kind: 'member', id: memberId }, { from: `member:${memberId}` })
  return (
    <section aria-label={t('kubecode.task.people')} className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{t('kubecode.task.people')}</h4>
      {detail.participants.length === 0
        ? <ReaderEmpty>{t('kubecode.task.noParticipants')}</ReaderEmpty>
        : (
          <ul className="flex flex-col gap-2">
            {[...manager, ...specialists].map((member) => (
              <li key={member.member_id}>
                <MemberIdentity
                  handle={member.handle}
                  name={member.name}
                  role={member.role === 'general' ? 'manager' : 'specialist'}
                  roleLabel={member.role === 'general' ? t('kubecode.task.manager') : t('kubecode.task.specialist')}
                  size="sm"
                  onOpen={() => open(member.member_id)}
                />
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

function Progress({ detail, t }: { detail: TaskDetail; t: Translator }) {
  const progress = progressOf(detail.work)
  return (
    <section aria-label={t('kubecode.task.progress')} className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">{t('kubecode.task.progress')}</h4>
      <p className="text-sm text-muted-foreground">
        {progress ? t('kubecode.task.card.progress', progress) : t('kubecode.task.card.noWork')}
      </p>
      {detail.internal_work.length > 0 && (
        <Task open>
          <TaskContent role="list">
            {detail.internal_work.map((work) => {
              const condition = conditionLabel(t, work.condition)
              return (
                <TaskItem className="flex flex-wrap items-center gap-2" key={work.id} role="listitem">
                  <strong className="text-foreground [overflow-wrap:anywhere]">{work.title}</strong>
                  <StatusBadge>{t(`kubecode.work.stage.${work.stage}`)}</StatusBadge>
                  {condition && <StatusBadge tone="warn">{condition}</StatusBadge>}
                  {work.assignee && <small>@{work.assignee.handle}</small>}
                  <small>
                    {t('kubecode.task.workCounts', { attempts: work.attempts, experiments: work.experiments })}
                  </small>
                </TaskItem>
              )
            })}
          </TaskContent>
        </Task>
      )}
    </section>
  )
}
