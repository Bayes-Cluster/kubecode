import { useContext, useState } from 'react'

import { Task, TaskContent, TaskItem } from '@/components/ai-elements/task'
import { Button } from '@/components/ui/button'
import { Icon } from '@/kubecode/icons'
import { WORKSPACE_COMMAND_ICONS } from '@/kubecode/icons/workspaceIcons'

import type { SourceDelivery, TaskDetail } from '../api'
import { useInspectorServices } from '../app/inspector/inspectorContext'
import { WorkspaceNavigationContext } from '../app/location/WorkspaceNavigation'
import { useAttention } from '../attention/attentionContext'
import { askerName, attentionTarget } from '../attention/attentionTargets'
import { recipientName, retryingText, retryRefusal } from '../attention/deliveryWords'
import { ExecutionStrip } from '../attention/ExecutionStrip'
import { RoundPauseControl } from '../attention/RoundPauseControl'

function DeliveryIssue({ issue, onChanged, projectId }: { issue: SourceDelivery; projectId: string; onChanged: () => void }) {
  const { api, t } = useInspectorServices()
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const name = recipientName(issue.route, t)
  const retry = async () => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      await api.retryRoute(projectId, issue.route.route_id)
      onChanged()
    } catch (cause) {
      setRefusal(retryRefusal(cause, name, t))
    } finally {
      setBusy(false)
    }
  }
  const retrying = issue.route.state !== 'failed'
  // An older verdict the Task moved past is listed, never delivered late.
  if (issue.route.superseded) {
    return (
      <li className="kubecode-delivery-status" data-state="superseded">
        <span className="kubecode-research-muted">{t('kubecode.delivery.superseded', { name })}</span>
      </li>
    )
  }
  return (
    <li className="kubecode-delivery-status" data-state={issue.route.state}>
      <span className={retrying ? 'kubecode-research-muted' : 'kubecode-research-error'}>
        {retrying
          ? retryingText(issue.route, t)
          : t('kubecode.delivery.decisionFailed', { name })}
      </span>
      {!retrying && issue.route.retryable && (
        <Button aria-busy={busy || undefined} size="xs" variant="ghost" onClick={() => void retry()}>
          <Icon role="command" size="secondary" source={WORKSPACE_COMMAND_ICONS.retry.Icon} />
          {t('kubecode.delivery.retry', { name })}
        </Button>
      )}
      {refusal && <span className="kubecode-research-error" role="alert">{refusal}</span>}
    </li>
  )
}

/**
 * What runs on a Task now and what it waits on (ADR 0232): "Pause new work on
 * {task}", who is working on it with a Stop that names their turn, who waits
 * for the researcher's permission — with a way to the one prompt that answers
 * it — and decisions on it that did not reach their recipient.
 */
export function TaskWork({ detail, onChanged, projectId }: { detail: TaskDetail; projectId: string; onChanged: () => void }) {
  const { api, t } = useInspectorServices()
  const attention = useAttention()
  const navigation = useContext(WorkspaceNavigationContext)
  const waiting = (attention?.forTask(detail.id) ?? []).filter((item) => item.kind === 'permission' || item.kind === 'input')
  const issues = detail.delivery_issues ?? []
  return (
    <div className="kubecode-task-work">
      {detail.execution && (
        <RoundPauseControl
          api={api}
          execution={detail.execution}
          projectId={projectId}
          t={t}
          task={{ id: detail.id, title: detail.title }}
          onChanged={onChanged}
        />
      )}
      {waiting.length > 0 && (
        <Task className="kubecode-task-waiting" open>
          <TaskContent role="list">
            {waiting.map((item) => {
              const target = attentionTarget(item, navigation?.presentation ?? 'screen')
              const name = askerName(item, t)
              return (
                <TaskItem className="kubecode-task-waiting-item" key={item.key} role="listitem">
                  <span>
                    {t(item.kind === 'permission' ? 'kubecode.attention.waitingInTask' : 'kubecode.attention.waitingInputInTask', { name })}
                  </span>
                  {navigation && (
                    <Button
                      aria-label={t('kubecode.attention.showRequest', { name })}
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        if (target.session) {
                          navigation.openSession(target.session.conversationId, target.session.projectId, { focus: target.focus })
                        }
                        else if (target.place) {
                          navigation.openPlace(target.place, {
                            ...(target.inspect ? { inspect: target.inspect } : {}),
                            focus: target.focus,
                          })
                        }
                      }}
                    >
                      {t('kubecode.attention.show')}
                    </Button>
                  )}
                </TaskItem>
              )
            })}
          </TaskContent>
        </Task>
      )}
      <ExecutionStrip api={api} prompts={false} scope={{ taskId: detail.id }} t={t} />
      {issues.length > 0 && (
        <ul className="kubecode-task-delivery-issues">
          {issues.map((issue) => (
            <DeliveryIssue issue={issue} key={issue.route.route_id} projectId={projectId} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  )
}
