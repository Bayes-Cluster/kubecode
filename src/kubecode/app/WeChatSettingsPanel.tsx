import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  QrCode,
  RotateCw,
  Unplug,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { ApiError } from '../api'
import type {
  Conversation,
  IlinkConnectionStatus,
  IlinkQuickPrompts,
  IlinkStatus,
  KubecodeApi,
  Project,
  WorkspaceEvent,
} from '../api'

import { wechatUnbindableReason, type WeChatBinding } from './useWeChatBinding'

import {
  LOGIN_STATUSES,
  WECHAT_LOGIN_POLL_MS,
  projectWeChatStatus,
  type WeChatAction,
  type WeChatViewModel,
} from './wechatStatus'

type QrImage = { svg: string; generation: number | null }

type ErrorKey =
  | 'kubecode.wechat.errorCooldown'
  | 'kubecode.wechat.errorState'
  | 'kubecode.wechat.errorNotLinked'
  | 'kubecode.wechat.errorGeneric'
  | 'kubecode.wechat.verificationStale'

function errorKey(error: unknown, action: WeChatAction): ErrorKey {
  if (error instanceof ApiError) {
    if (error.code === 'ilink_cooldown_active') return 'kubecode.wechat.errorCooldown'
    if (error.code === 'ilink_not_available') return 'kubecode.wechat.errorNotLinked'
    if (error.code === 'ilink_invalid_state') {
      return action === 'verify' ? 'kubecode.wechat.verificationStale' : 'kubecode.wechat.errorState'
    }
  }
  return 'kubecode.wechat.errorGeneric'
}

function statusTone(status: IlinkConnectionStatus): 'ok' | 'pending' | 'problem' | 'idle' {
  if (status === 'connected') return 'ok'
  if (LOGIN_STATUSES.has(status) || status === 'backing_off') return 'pending'
  if (status === 'disconnected') return 'idle'
  return 'problem'
}

export function WeChatSettingsPanel({
  api,
  binding,
  conversations = [],
  projects = [],
  t,
  workspaceEvents,
}: {
  api: KubecodeApi
  binding?: WeChatBinding
  conversations?: Conversation[]
  projects?: Project[]
  t: Translator
  workspaceEvents: WorkspaceEvent[]
}) {
  const [view, setView] = useState<WeChatViewModel | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [qr, setQr] = useState<QrImage | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<WeChatAction | null>(null)
  const [actionError, setActionError] = useState<ErrorKey | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // Every request takes a ticket; only the newest response may land, so a
  // slow reply from an older login generation can never overwrite state.
  const ticket = useRef(0)
  const processedEvent = useRef(workspaceEvents.at(-1)?.id ?? 0)

  const applyStatus = useCallback((status: IlinkStatus, qrSvg?: string | null) => {
    const next = projectWeChatStatus(status)
    setView(next)
    setLoadFailed(false)
    if (!status.login_active) {
      setQr(null)
      setCode('')
    } else if (qrSvg) {
      setQr({ svg: qrSvg, generation: next.loginGeneration })
    }
  }, [])

  const refresh = useCallback(async () => {
    const mine = ++ticket.current
    try {
      const status = await api.ilinkStatus()
      if (mine !== ticket.current) return
      if (status.login_active) {
        const poll = await api.ilinkPollLogin()
        if (mine !== ticket.current) return
        applyStatus(poll, poll.qr_svg)
      } else {
        applyStatus(status)
      }
    } catch {
      if (mine === ticket.current) setLoadFailed(true)
    }
  }, [api, applyStatus])

  useEffect(() => {
    void refresh()
    return () => {
      // Closing the section drops the QR image immediately.
      ticket.current += 1
    }
  }, [refresh])

  // Converge on channel changes made elsewhere (other tabs, the server).
  useEffect(() => {
    const changed = workspaceEvents.some((event) => (
      event.id > processedEvent.current && event.kind === 'ilink_status_changed'
    ))
    processedEvent.current = workspaceEvents.at(-1)?.id ?? processedEvent.current
    if (changed) void refresh()
  }, [refresh, workspaceEvents])

  // Poll only the login endpoint, and only while a login is in progress.
  const loginInProgress = view ? LOGIN_STATUSES.has(view.status) : false
  useEffect(() => {
    if (!loginInProgress) return
    const timer = window.setInterval(() => {
      const mine = ++ticket.current
      void api.ilinkPollLogin().then((poll) => {
        if (mine === ticket.current) applyStatus(poll, poll.qr_svg)
      }).catch(() => undefined)
    }, WECHAT_LOGIN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, applyStatus, loginInProgress])

  const run = async (action: WeChatAction, operation: () => Promise<unknown>) => {
    setBusy(action)
    setActionError(null)
    ticket.current += 1
    let result: 'ok' | 'error' = 'ok'
    try {
      await operation()
    } catch (error) {
      result = 'error'
      setActionError(errorKey(error, action))
    } finally {
      setBusy(null)
    }
    trackEvent('kubecode_wechat_action', { action, result })
    await refresh()
  }

  const connect = () => run('connect', async () => {
    const start = await api.ilinkStartLogin()
    if (start.qr_svg) setQr({ svg: start.qr_svg, generation: start.generation })
  })

  const verify = () => {
    const trimmed = code.trim()
    if (!trimmed) return
    void run('verify', async () => {
      await api.ilinkVerify(trimmed, qr?.generation ?? view?.loginGeneration ?? null)
      setCode('')
    })
  }

  if (!view) {
    return (
      <div className="kubecode-settings-group" data-testid="wechat-settings-panel">
        <div className="kubecode-setting-row">
          <div>
            <strong>{t('kubecode.wechat.connection')}</strong>
            {loadFailed
              ? <span role="alert">{t('kubecode.wechat.errorLoad')}</span>
              : <span role="status">{t('kubecode.wechat.loading')}</span>}
          </div>
          {loadFailed && (
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <RotateCw size={16} />
              {t('kubecode.refresh')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const tone = statusTone(view.status)
  const canConnect = !view.linked
    || view.status === 'expired'
    || view.status === 'verification_blocked'
  const canReconnect = view.linked && (view.status === 'backing_off' || view.status === 'error')
  const StatusIcon = tone === 'ok' ? CircleCheck : tone === 'problem' ? CircleAlert : tone === 'pending' ? LoaderCircle : QrCode

  return (
    <>
      <div className="kubecode-settings-group" data-testid="wechat-settings-panel">
        <div className="kubecode-setting-row">
          <div>
            <strong>{t('kubecode.wechat.connection')}</strong>
            <span>{t('kubecode.wechat.connectionDescription')}</span>
          </div>
        </div>
        <div className="kubecode-setting-row kubecode-wechat-status" data-tone={tone}>
          <div aria-live="polite" role="status">
            <strong>
              <StatusIcon
                aria-hidden="true"
                className={tone === 'pending' ? 'animate-spin' : undefined}
                size={16}
              />
              {t(`kubecode.wechat.status.${view.status}`)}
            </strong>
            <span>{t(`kubecode.wechat.statusDescription.${view.status}`)}</span>
            {view.linked && view.displayName && (
              <span>{t('kubecode.wechat.account', { name: view.displayName })}</span>
            )}
          </div>
          <div className="kubecode-wechat-actions">
            {canConnect && !loginInProgress && (
              <Button disabled={busy !== null} size="sm" onClick={() => void connect()}>
                <QrCode size={16} />
                {view.linked ? t('kubecode.wechat.newQr') : t('kubecode.wechat.connect')}
              </Button>
            )}
            {loginInProgress && (
              <Button
                disabled={busy !== null}
                size="sm"
                variant="outline"
                onClick={() => void run('cancel', () => api.ilinkCancelLogin())}
              >
                {t('kubecode.wechat.cancelLogin')}
              </Button>
            )}
            {canReconnect && (
              <Button
                disabled={busy !== null}
                size="sm"
                variant="outline"
                onClick={() => void run('reconnect', () => api.ilinkReconnect())}
              >
                <RotateCw className={busy === 'reconnect' ? 'animate-spin' : undefined} size={16} />
                {t('kubecode.wechat.reconnect')}
              </Button>
            )}
            {view.linked && (
              <Button
                disabled={busy !== null}
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDisconnect(true)}
              >
                <Unplug size={16} />
                {t('kubecode.wechat.disconnect')}
              </Button>
            )}
          </div>
        </div>
        {actionError && (
          <div className="kubecode-setting-row kubecode-wechat-error">
            <span role="alert">{t(actionError)}</span>
          </div>
        )}
        {loginInProgress && qr && (
          <figure className="kubecode-wechat-qr">
            <img alt={t('kubecode.wechat.qrAlt')} height={200} src={qr.svg} width={200} />
            <figcaption>
              <span>{t('kubecode.wechat.qrInstructions')}</span>
              {view.loginExpiresInMs !== null && (
                <span>{t('kubecode.wechat.qrExpires', {
                  minutes: Math.max(1, Math.ceil(view.loginExpiresInMs / 60000)),
                })}</span>
              )}
            </figcaption>
          </figure>
        )}
        {view.status === 'verification_required' && (
          <form
            className="kubecode-setting-row kubecode-wechat-verify"
            onSubmit={(event) => {
              event.preventDefault()
              verify()
            }}
          >
            <div>
              <label htmlFor="kubecode-wechat-code"><strong>{t('kubecode.wechat.verificationCode')}</strong></label>
              <span>{t('kubecode.wechat.verificationCodeDescription')}</span>
            </div>
            <div className="kubecode-wechat-actions">
              <Input
                autoComplete="one-time-code"
                className="kubecode-wechat-code"
                id="kubecode-wechat-code"
                inputMode="numeric"
                maxLength={12}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button disabled={busy !== null || !code.trim()} size="sm" type="submit">
                {t('kubecode.wechat.verify')}
              </Button>
            </div>
          </form>
        )}
      </div>
      {view.linked && binding && (
        <>
          <h3 className="kubecode-settings-section-heading">{t('kubecode.wechat.activeSession')}</h3>
          <ActiveSessionSelector
            binding={binding}
            conversations={conversations}
            projects={projects}
            t={t}
          />
        </>
      )}
      {view.linked && (
        <>
          <h3 className="kubecode-settings-section-heading">{t('kubecode.wechat.quickPrompts')}</h3>
          <QuickPromptsEditor api={api} t={t} />
        </>
      )}
      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('kubecode.wechat.disconnectTitle')}</DialogTitle>
            <DialogDescription>{t('kubecode.wechat.disconnectDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
              {t('kubecode.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDisconnect(false)
                void run('disconnect', () => api.ilinkDisconnect())
              }}
            >
              {t('kubecode.wechat.disconnectConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Sentinel select value meaning "no active Session". */
const NO_SESSION = '__none__'

function ActiveSessionSelector({
  binding,
  conversations,
  projects,
  t,
}: {
  binding: WeChatBinding
  conversations: Conversation[]
  projects: Project[]
  t: Translator
}) {
  const groups = projects
    .map((project) => ({
      project,
      sessions: conversations.filter((conversation) => (
        conversation.project_id === project.id && conversation.relationship !== 'subagent'
      )),
    }))
    .filter((group) => group.sessions.length > 0)
  const bound = binding.boundConversationId
  const title = (conversation: Conversation) => conversation.title || t('kubecode.untitledSession')
  return (
    <div className="kubecode-settings-group" data-testid="wechat-active-session">
      <div className="kubecode-setting-row">
        <div>
          <strong>{t('kubecode.wechat.activeSession')}</strong>
          <span>{t('kubecode.wechat.activeSessionDescription')}</span>
          {binding.clearedReason && !bound && (
            <span role="status">{t(`kubecode.wechat.bindingCleared.${binding.clearedReason}`)}</span>
          )}
          {binding.rejected && (
            <span role="alert">{t(`kubecode.wechat.bindingRejected.${binding.rejected}`)}</span>
          )}
        </div>
        <div className="kubecode-wechat-actions">
          <Select
            disabled={binding.pending}
            value={bound ?? NO_SESSION}
            onValueChange={(value) => {
              if (value === NO_SESSION) return
              trackEvent('kubecode_wechat_session_binding_changed', { action: 'bind', source: 'settings' })
              void binding.bind(value)
            }}
          >
            <SelectTrigger aria-label={t('kubecode.wechat.activeSession')} className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem disabled value={NO_SESSION}>{t('kubecode.wechat.noActiveSession')}</SelectItem>
              {groups.map(({ project, sessions }) => (
                <SelectGroup key={project.id}>
                  <SelectLabel>{project.name}</SelectLabel>
                  {sessions.map((conversation) => {
                    const reason = wechatUnbindableReason(conversation)
                    return (
                      <SelectItem disabled={Boolean(reason)} key={conversation.id} value={conversation.id}>
                        {reason
                          ? t('kubecode.wechat.sessionUnavailable', {
                            title: title(conversation),
                            reason: t(`kubecode.wechat.unbindable.${reason}`),
                          })
                          : title(conversation)}
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {bound && (
            <Button
              disabled={binding.pending}
              size="sm"
              variant="ghost"
              onClick={() => {
                trackEvent('kubecode_wechat_session_binding_changed', { action: 'unbind', source: 'settings' })
                void binding.unbind()
              }}
            >
              {t('kubecode.wechat.unbind')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function QuickPromptsEditor({ api, t }: { api: KubecodeApi; t: Translator }) {
  const [prompts, setPrompts] = useState<IlinkQuickPrompts | null>(null)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    void api.ilinkQuickPrompts().then((next) => {
      if (!current) return
      setPrompts(next)
      setDrafts(Object.fromEntries(next.prompts.map((prompt) => [prompt.slot, prompt.content])))
      setFailed(false)
    }).catch(() => {
      if (current) setFailed(true)
    })
    return () => { current = false }
  }, [api, reload])
  const load = () => setReload((value) => value + 1)

  if (!prompts) {
    return failed
      ? <div className="kubecode-settings-group"><div className="kubecode-setting-row"><span role="alert">{t('kubecode.wechat.errorGeneric')}</span></div></div>
      : null
  }
  const used = new Set(prompts.prompts.map((prompt) => prompt.slot))
  const freeSlot = Array.from({ length: prompts.slots }, (_, index) => index + 1)
    .find((slot) => !used.has(slot))
  const slots = [...prompts.prompts.map((prompt) => prompt.slot), ...(freeSlot ? [freeSlot] : [])]

  const save = async (slot: number) => {
    const content = (drafts[slot] ?? '').trim()
    try {
      if (content) await api.ilinkSetQuickPrompt(slot, content)
      else await api.ilinkRemoveQuickPrompt(slot)
    } catch {
      // Keep the typed draft and the error until the user acts again.
      setFailed(true)
      return
    }
    trackEvent('kubecode_wechat_quick_prompt_changed', { action: content ? 'save' : 'remove' })
    load()
  }

  return (
    <div className="kubecode-settings-group" data-testid="wechat-quick-prompts">
      <div className="kubecode-setting-row">
        <div>
          <strong>{t('kubecode.wechat.quickPrompts')}</strong>
          <span>{t('kubecode.wechat.quickPromptsDescription')}</span>
          {failed && <span role="alert">{t('kubecode.wechat.errorGeneric')}</span>}
        </div>
      </div>
      {slots.map((slot) => {
        const saved = prompts.prompts.find((prompt) => prompt.slot === slot)?.content ?? ''
        const draft = drafts[slot] ?? ''
        const label = t('kubecode.wechat.quickPromptSlot', { slot })
        return (
          <div className="kubecode-setting-row kubecode-wechat-quick-prompt" key={slot}>
            <Textarea
              aria-label={label}
              maxLength={prompts.max_chars}
              placeholder={saved ? undefined : t('kubecode.wechat.quickPromptPlaceholder')}
              rows={2}
              value={draft}
              onChange={(event) => setDrafts((current) => ({ ...current, [slot]: event.target.value }))}
            />
            <div className="kubecode-wechat-actions">
              <Button
                disabled={draft.trim() === saved}
                size="sm"
                variant="outline"
                onClick={() => void save(slot)}
              >
                {saved ? t('kubecode.save') : t('kubecode.wechat.addQuickPrompt')}
              </Button>
              {saved && (
                <Button
                  aria-label={t('kubecode.wechat.removeQuickPrompt', { slot })}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void api.ilinkRemoveQuickPrompt(slot).then(() => {
                      trackEvent('kubecode_wechat_quick_prompt_changed', { action: 'remove' })
                      load()
                    }).catch(() => setFailed(true))
                  }}
                >
                  {t('common.remove')}
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
