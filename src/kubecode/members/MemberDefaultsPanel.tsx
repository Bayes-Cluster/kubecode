import { Lock, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type { AgentDescriptor, AgentId, KubecodeApi, MemberDefaults, MemberTemplate } from '../api'
import { agentName } from '../session/sessionModel'
import {
  configFromRows,
  configRows,
  isMemberStale,
  lockedManagerOption,
  memberErrorMessage,
  SPECIALIST_TEMPLATES,
  TEMPLATE_LABELS,
} from './memberModel'

export type MemberDefaultsPanelProps = {
  agents: AgentDescriptor[]
  api: KubecodeApi
  onLoaded?: (defaults: MemberDefaults) => void
  t: Translator
}

/**
 * What new members start from: the General Agent's provider, configuration
 * values, and instructions, and each specialist template's instructions.
 * Saved on the server, so every browser and every new Workspace agrees. A
 * change reaches new members only.
 */
export function MemberDefaultsPanel({ agents, api, onLoaded, t }: MemberDefaultsPanelProps) {
  const [saved, setSaved] = useState<MemberDefaults | null>(null)
  const [agentId, setAgentId] = useState<AgentId>('claude_code')
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([])
  const [instructions, setInstructions] = useState('')
  const [templates, setTemplates] = useState<Partial<Record<MemberTemplate, string>>>({})
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)

  const adopt = (defaults: MemberDefaults, keepEdits = false) => {
    setSaved(defaults)
    onLoaded?.(defaults)
    if (keepEdits) return
    setAgentId(defaults.general.agent_id)
    setRows(configRows(defaults.general.config))
    setInstructions(defaults.general.instructions)
    setTemplates(defaults.templates)
  }

  useEffect(() => {
    let live = true
    api.memberDefaults().then(
      (defaults) => { if (live) adopt(defaults) },
      () => { if (live) setLoadFailed(true) },
    )
    return () => { live = false }
    // adopt only sets state; it is not a dependency of the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  if (!saved) {
    return (
      <div>
        <p className="kubecode-research-muted" role={loadFailed ? 'alert' : 'status'}>
          {loadFailed ? t('kubecode.members.defaults.loadFailed') : t('kubecode.members.loading')}
        </p>
        {loadFailed && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setLoadFailed(false)
              api.memberDefaults().then(adopt, () => setLoadFailed(true))
            }}
          >
            {t('kubecode.members.retryLoad')}
          </Button>
        )}
      </div>
    )
  }

  const dirty = agentId !== saved.general.agent_id
    || JSON.stringify(configFromRows(rows)) !== JSON.stringify(saved.general.config)
    || instructions !== saved.general.instructions
    || SPECIALIST_TEMPLATES.some((template) => (templates[template] ?? '') !== (saved.templates[template] ?? ''))
  const lockedKey = lockedManagerOption(rows)

  const save = async () => {
    if (lockedKey !== null) return
    setBusy(true)
    setMessage(null)
    try {
      const next = await api.saveMemberDefaults(saved.revision, {
        general: { agent_id: agentId, config: configFromRows(rows), instructions },
        templates,
      })
      adopt(next)
      setMessage({ tone: 'ok', text: t('kubecode.members.defaults.saved') })
    } catch (cause) {
      setMessage({ tone: 'error', text: memberErrorMessage(cause, t) })
      if (isMemberStale(cause)) {
        // Take the newer revision but keep what was typed; saving again is
        // a deliberate overwrite.
        api.memberDefaults().then((latest) => adopt(latest, true), () => undefined)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t('kubecode.members.defaults.title')} className="kubecode-member-defaults">
      <header className="kubecode-members-header">
        <div>
          <h3>{t('kubecode.members.defaults.title')}</h3>
          <p className="kubecode-research-muted">{t('kubecode.members.defaults.description')}</p>
        </div>
        {dirty && <StatusBadge tone="warn">{t('kubecode.members.defaults.unsaved')}</StatusBadge>}
      </header>
      <form
        className="kubecode-member-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) void save()
        }}
      >
        <label>
          <span>{t('kubecode.members.provider')}</span>
          <select
            className="kubecode-channel-select"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value as AgentId)}
          >
            {agents.map((agent) => (
              <option disabled={!agent.available && agent.id !== agentId} key={agent.id} value={agent.id}>
                {agentName(agent.id)}{agent.available ? '' : ` — ${t('kubecode.unavailable')}`}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>{t('kubecode.members.defaults.config')}</legend>
          <small className="kubecode-research-muted">{t('kubecode.members.defaults.configHint')}</small>
          {rows.map((row, index) => (
            <div className="kubecode-member-config-row" key={index}>
              <input
                aria-invalid={row.key === lockedKey || undefined}
                aria-label={`${t('kubecode.members.defaults.configKey')} ${index + 1}`}
                className="kubecode-channel-select"
                value={row.key}
                onChange={(event) => setRows(rows.map((r, i) => i === index ? { ...r, key: event.target.value } : r))}
              />
              <input
                aria-label={`${t('kubecode.members.defaults.configValue')} ${index + 1}`}
                className="kubecode-channel-select"
                value={row.value}
                onChange={(event) => setRows(rows.map((r, i) => i === index ? { ...r, value: event.target.value } : r))}
              />
              <IconButton
                icon={<X aria-hidden size={14} />}
                label={`${t('kubecode.members.defaults.removeConfig')} ${index + 1}`}
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              />
            </div>
          ))}
          {lockedKey !== null && (
            <p className="kubecode-research-error" role="alert">
              {t('kubecode.members.defaults.modeLocked', { key: lockedKey.trim() })}
            </p>
          )}
          <Button size="xs" type="button" variant="outline" onClick={() => setRows([...rows, { key: '', value: '' }])}>
            <Plus aria-hidden size={14} />
            {t('kubecode.members.defaults.addConfig')}
          </Button>
        </fieldset>
        <label>
          <span>{t('kubecode.members.defaults.generalInstructions')}</span>
          <Textarea rows={6} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        </label>
        <p className="kubecode-member-locked" role="note">
          <Lock aria-hidden size={12} />
          <span>{t('kubecode.members.defaults.boundary')}</span>
        </p>
        <fieldset>
          <legend>{t('kubecode.members.defaults.templates')}</legend>
          <small className="kubecode-research-muted">{t('kubecode.members.defaults.templatesHint')}</small>
          {SPECIALIST_TEMPLATES.filter((template) => template !== 'custom').map((template) => (
            <label key={template}>
              <span>{t('kubecode.members.defaults.templateInstructions', { role: t(TEMPLATE_LABELS[template]) })}</span>
              <Textarea
                rows={3}
                value={templates[template] ?? ''}
                onChange={(event) => setTemplates({ ...templates, [template]: event.target.value })}
              />
            </label>
          ))}
        </fieldset>
        {message && (
          <p className={message.tone === 'error' ? 'kubecode-research-error' : 'kubecode-research-muted'} role={message.tone === 'error' ? 'alert' : 'status'}>
            {message.text}
          </p>
        )}
        <div className="kubecode-work-command-row">
          <Button disabled={busy || !dirty || lockedKey !== null} size="sm" type="submit">
            {t('kubecode.members.save')}
          </Button>
          {dirty && (
            <Button size="sm" type="button" variant="ghost" onClick={() => adopt(saved)}>
              {t('kubecode.members.cancel')}
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
