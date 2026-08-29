import { LockKeyhole, ShieldAlert } from 'lucide-react'

import { AiPanelComposer } from '@/components/AiPanelChrome'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { AppLocale, Translator } from '@/lib/i18n'

import { AcpCommandMenu } from '../AcpCommandMenu'
import { completeAcpCommand, type AcpCommand } from '../acpCommands'
import { AgentControlMenu } from '../AgentControlMenu'
import type { NativeSessionConfig, NativeSessionSelect } from '../agentSessionOptions'
import type { AgentRun, AgentSessionState, Conversation, KubecodeApi } from '../api'
import { ComposerAddMenu } from '../ComposerAddMenu'
import { ComposerContextInput } from '../ComposerContextInput'
import { composerDraftHasStaleContext } from '../composerDraft'
import { SideQuestionPanel, type SideQuestionItem } from '../SideQuestionPanel'
import { SystemMessageNotice } from '../SystemMessageNotice'
import type { TerminalContextSource } from '../TerminalWorkspace'
import { SessionPlanSummary, type SessionPlanEntry } from './SessionPlanSummary'
import {
  elicitationComplete,
  nativeModeLockMessage,
  permissionChoiceLabel,
  sideQuestionText,
  type ElicitationAnswer,
  type PendingElicitation,
  type PendingPermission,
} from './sessionModel'
import type { ComposerController } from './useComposerController'
import type { SessionStateController } from './useSessionState'

type SessionComposerProps = {
  agentLabel: string
  api: KubecodeApi
  changeNativeMode: (value: string) => void
  commands: AcpCommand[]
  composer: ComposerController
  configSelects: NativeSessionConfig[]
  conversation: Conversation
  directTeammateChatDisabled: boolean
  elicitationAnswers: Record<string, ElicitationAnswer>
  error: string | null
  hardReadOnly: boolean
  isActive: boolean
  leaderReviewPending: boolean
  locale: AppLocale
  modeLockReason: NonNullable<AgentSessionState['mode_access']>['reason']
  nativeMode: NativeSessionSelect | null
  onDismissError: () => void
  onDismissWorkspaceWarning: () => void
  onChangeAgentConfig: (configId: string, value: string | boolean) => void
  onElicitationAnswerChange: (id: string, value: ElicitationAnswer) => void
  onOpenPlan?: () => void
  onResolveElicitation: (accepted: boolean) => void
  onResolvePermission: (requestId: string, optionId: string) => void
  onSend: (text: string) => void
  onSendSideQuestion: (text: string) => void
  onStop: () => void
  onUndoTurn: () => void
  openCodeCapabilityEmptyLabel: string | undefined
  pendingElicitation: PendingElicitation | null
  pendingPermission: PendingPermission | null
  planEntries: SessionPlanEntry[]
  projectId: string | null
  readiness: 'ready' | 'missing'
  reportError: (cause: unknown) => void
  run: AgentRun | null
  session: SessionStateController
  sideQuestionAvailable: boolean
  sideQuestions: SideQuestionItem[]
  t: Translator
  terminalContextSources: TerminalContextSource[]
  viewRevisionId: string | null
  workspaceWarning: string | null
}

export function SessionComposer({
  agentLabel,
  api,
  changeNativeMode,
  commands,
  composer,
  configSelects,
  conversation,
  directTeammateChatDisabled,
  elicitationAnswers,
  error,
  hardReadOnly,
  isActive,
  leaderReviewPending,
  locale,
  modeLockReason,
  nativeMode,
  onDismissError,
  onDismissWorkspaceWarning,
  onChangeAgentConfig,
  onElicitationAnswerChange,
  onOpenPlan,
  onResolveElicitation,
  onResolvePermission,
  onSend,
  onSendSideQuestion,
  onStop,
  onUndoTurn,
  openCodeCapabilityEmptyLabel,
  pendingElicitation,
  pendingPermission,
  planEntries,
  projectId,
  readiness,
  reportError,
  run,
  session,
  sideQuestionAvailable,
  sideQuestions,
  t,
  terminalContextSources,
  viewRevisionId,
  workspaceWarning,
}: SessionComposerProps) {
  const completedPlanEntries = planEntries.filter((entry) => entry.status === 'completed').length

  return (
    <div
      className="kubecode-session-composer-dock"
      onKeyDownCapture={(event) => {
        // Accelerated steer gesture (#98): Ctrl/Cmd+Enter while a run is
        // active submits and sends the draft immediately (cancel-and-replace).
        if (!isActive) return
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
        if (composer.composerSubmitDisabled || !composer.prompt) return
        event.preventDefault()
        event.stopPropagation()
        void composer.sendNow(composer.prompt)
      }}
    >
      <SideQuestionPanel items={sideQuestions} t={t} />
      {error && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
          dismissLabel={t('window.close')}
          level="error"
          message={error}
          onDismiss={onDismissError}
        />
      )}
      {workspaceWarning && (
        <SystemMessageNotice
          detailsLabel={t('kubecode.details')}
          dismissLabel={t('window.close')}
          level="warning"
          message={workspaceWarning}
          onDismiss={onDismissWorkspaceWarning}
        />
      )}
      {pendingPermission && (
        <div aria-live="polite" className="kubecode-permission-dock">
          <div className="kubecode-permission-heading">
            <ShieldAlert size={17} />
            <strong>{t('kubecode.permissionRequired')}</strong>
          </div>
          <code className="kubecode-permission-command">{pendingPermission.tool}</code>
          <div className="kubecode-permission-actions">
            {pendingPermission.options.map((option) => (
              <Button
                key={option.id}
                size="sm"
                title={option.label}
                variant={option.kind.startsWith('reject') ? 'outline' : 'default'}
                onClick={() => void onResolvePermission(pendingPermission.requestId, option.id)}
              >
                {permissionChoiceLabel(option, t)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {leaderReviewPending && (
        <div aria-live="polite" className="kubecode-permission-dock kubecode-permission-leader-review">
          <div className="kubecode-permission-heading">
            <ShieldAlert size={17} />
            <strong>{t('kubecode.waitingForLeaderPermission')}</strong>
          </div>
        </div>
      )}
      {pendingElicitation && (
        <div className="kubecode-elicitation-dock">
          <div className="kubecode-elicitation-heading">
            <strong>{t('kubecode.answerAgentQuestion')}</strong>
            <span>{pendingElicitation.message}</span>
          </div>
          <div className="kubecode-elicitation-fields">
            {pendingElicitation.properties.map((property) => (
              <label key={property.id} className="kubecode-elicitation-field">
                <span>{property.label}{property.required ? ' *' : ''}</span>
                {property.description && <small>{property.description}</small>}
                {property.type === 'boolean' ? (
                  <Switch
                    aria-label={property.label}
                    checked={Boolean(elicitationAnswers[property.id])}
                    onCheckedChange={(value) => onElicitationAnswerChange(property.id, value)}
                  />
                ) : property.options.length > 0 ? (
                  <Select
                    value={String(elicitationAnswers[property.id] ?? '')}
                    onValueChange={(value) => onElicitationAnswerChange(property.id, value)}
                  >
                    <SelectTrigger aria-label={property.label}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {property.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={property.label}
                    type={property.type === 'string' ? 'text' : 'number'}
                    value={String(elicitationAnswers[property.id] ?? '')}
                    onChange={(event) => onElicitationAnswerChange(property.id, event.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="kubecode-elicitation-actions">
            <Button size="sm" variant="outline" onClick={() => void onResolveElicitation(false)}>
              {t('kubecode.decline')}
            </Button>
            <Button
              disabled={!elicitationComplete(pendingElicitation, elicitationAnswers)}
              size="sm"
              onClick={() => void onResolveElicitation(true)}
            >
              {t('kubecode.submitAnswers')}
            </Button>
          </div>
        </div>
      )}
      {planEntries.length > 0 && (
        <SessionPlanSummary
          completedEntries={completedPlanEntries}
          onOpenPlan={onOpenPlan}
          t={t}
          totalEntries={planEntries.length}
        />
      )}
      <div className="kubecode-session-composer">
        {hardReadOnly || viewRevisionId ? (
          <div className="kubecode-read-only-session">
            <LockKeyhole  size={16}/>
            <span>{viewRevisionId
              ? t('kubecode.revisionReadOnly')
              : t('kubecode.readOnlySubagent')}</span>
          </div>
        ) : (
          <>
            {!directTeammateChatDisabled
              && run
              && ['cancelled', 'failed', 'interrupted'].includes(run.status) && (
              <Button className="kubecode-undo-turn" size="sm" variant="ghost" onClick={() => void onUndoTurn()}>
                {t('kubecode.undoTurn')}
              </Button>
            )}
            {composer.visibleCommands.length > 0 && (
              <AcpCommandMenu
                commands={composer.visibleCommands}
                label={t('command.palettePlaceholder')}
                onHover={composer.setSelectedCommandIndex}
                onSelect={(command) => {
                  composer.updatePrompt(completeAcpCommand(command))
                  window.requestAnimationFrame(() => composer.inputRef.current?.focus())
                }}
                selectedIndex={composer.currentCommandIndex}
                unavailableLabel={t('kubecode.unavailable')}
              />
            )}
            <AiPanelComposer
              agentLabel={agentLabel}
              agentReadiness={readiness}
              disabled={directTeammateChatDisabled}
              disabledPlaceholder={t('kubecode.teammateChatDisabled')}
              leadingControl={projectId && !directTeammateChatDisabled ? (
                <ComposerAddMenu
                  api={api}
                  capabilityCatalog={session.sessionState?.composer?.catalog}
                  capabilityEmptyLabel={openCodeCapabilityEmptyLabel}
                  capabilityLabels={composer.capabilityLabels}
                  capabilityStatus={session.capabilityStatus}
                  commands={commands}
                  conversationId={conversation.id}
                  gitDiffLabels={composer.gitDiffLabels}
                  onCapability={composer.insertComposerCapability}
                  onGitDiff={composer.insertComposerGitDiff}
                  onInsert={composer.insertComposerText}
                  onReference={composer.insertComposerContext}
                  onSessionTurnContext={composer.insertComposerSessionTurnContext}
                  onTerminalContext={composer.insertComposerTerminalContext}
                  projectId={projectId}
                  sessionTurnSources={composer.sessionTurnSources}
                  t={t}
                  terminalSources={terminalContextSources}
                />
              ) : undefined}
              controls={nativeMode || configSelects.length > 0 ? (
                <AgentControlMenu
                  agent={conversation.agent_id}
                  configs={configSelects}
                  mode={nativeMode}
                  modeDisabled={Boolean(modeLockReason)}
                  modeDisabledReason={modeLockReason ? nativeModeLockMessage(modeLockReason, t) : undefined}
                  onConfigChange={onChangeAgentConfig}
                  onModeChange={changeNativeMode}
                  t={t}
                />
              ) : undefined}
              entries={[]}
              input={composer.prompt}
              inputContent={(
                <ComposerContextInput
                  api={api}
                  capabilityCatalog={session.sessionState?.composer?.catalog}
                  capabilityLabels={composer.capabilityLabels}
                  capabilityStatus={session.capabilityStatus}
                  contextEmptyLabel={t('kubecode.noContextFound')}
                  contextErrorLabel={t('kubecode.contextLoadFailed')}
                  contextLoadingLabel={t('kubecode.loadingContext')}
                  contextPickerLabel={t('kubecode.addContext')}
                  contextRemoveLabel={t('kubecode.removeContext')}
                  gitDiffLabels={composer.gitDiffLabels}
                  conversationId={conversation.id}
                  disabled={directTeammateChatDisabled || readiness !== 'ready'}
                  draft={composer.composerDraft}
                  inputRef={composer.inputRef}
                  onChange={composer.updateComposerDraft}
                  onCatalogChange={session.applyComposerCatalog}
                  onKeyDownCapture={composer.handleCommandKeyDown}
                  onPendingChange={composer.setInlineContextPending}
                  onRegistrationError={reportError}
                  onSubmit={(text) => {
                    if (composer.composerSubmitDisabled) return
                    if (isActive && !composer.composerHasTypedReferences
                      && sideQuestionAvailable && sideQuestionText(text)) {
                      void onSendSideQuestion(text)
                      return
                    }
                    // While a run is active plain text queues server-side
                    // (#97); slash drafts stay untouched — the command menu
                    // owns them until the run ends.
                    if (isActive && text.startsWith('/')) return
                    void onSend(text)
                  }}
                  placeholder={directTeammateChatDisabled
                    ? t('kubecode.teammateChatDisabled')
                    : readiness === 'missing'
                      ? t('ai.panel.placeholder.missing', { agent: agentLabel })
                      : t('ai.panel.placeholder.ready', { agent: agentLabel })}
                  submitDisabled={composer.composerSubmitDisabled}
                />
              )}
              inputRef={composer.inputRef}
              isActive={isActive}
              locale={locale}
              onChange={composer.updatePrompt}
              activeSendLabel={t('kubecode.askSideQuestion')}
              onActiveSend={sideQuestionAvailable && sideQuestionText(composer.prompt)
                ? (text) => void onSendSideQuestion(text)
                : undefined}
              onSend={(text) => void onSend(text)}
              onStop={() => void onStop()}
              sendDisabled={composer.composerSubmitDisabled}
              statusMessage={composerDraftHasStaleContext(composer.composerDraft)
                ? t('kubecode.staleContext')
                : undefined}
            />
          </>
          )}
      </div>
    </div>
  )
}
