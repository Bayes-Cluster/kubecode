import { CircleAlert, Lock, Plus, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { IconButton } from '@/components/workspace/IconButton'
import { StatusBadge } from '@/components/workspace/StatusBadge'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { Translator } from '@/lib/i18n'

import type { AgentDescriptor, AgentId, KubecodeApi, MemberDefaults, MemberTemplate } from '../api'
import {
  configFromRows,
  configRows,
  isMemberStale,
  lockedManagerOption,
  memberErrorMessage,
  SPECIALIST_TEMPLATES,
  TEMPLATE_LABELS,
} from './memberModel'
import { ProviderSelect } from './ProviderSelect'

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
  const fieldId = useId()

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
    const retry = () => {
      setLoadFailed(false)
      api.memberDefaults().then(adopt, () => setLoadFailed(true))
    }
    return loadFailed ? (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>{t('kubecode.members.defaults.loadFailed')}</AlertTitle>
        <AlertDescription>
          <Button size="sm" variant="outline" onClick={retry}>{t('kubecode.members.retryLoad')}</Button>
        </AlertDescription>
      </Alert>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner aria-hidden="true" />
        {t('kubecode.members.loading')}
      </p>
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
    <section aria-label={t('kubecode.members.defaults.title')} className="flex flex-col gap-4">
      <Item size="sm">
        <ItemContent>
          <ItemTitle><h3>{t('kubecode.members.defaults.title')}</h3></ItemTitle>
          <ItemDescription>{t('kubecode.members.defaults.description')}</ItemDescription>
        </ItemContent>
        {dirty && (
          <ItemActions>
            <StatusBadge tone="warn">{t('kubecode.members.defaults.unsaved')}</StatusBadge>
          </ItemActions>
        )}
      </Item>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) void save()
        }}
      >
        <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-provider`}>{t('kubecode.members.provider')}</FieldLabel>
          <ProviderSelect
            agents={agents}
            id={`${fieldId}-provider`}
            isSelectable={(agent) => agent.available || agent.id === agentId}
            t={t}
            value={agentId}
            onChange={setAgentId}
          />
        </Field>
        <FieldSet>
          <FieldLegend variant="label">{t('kubecode.members.defaults.config')}</FieldLegend>
          <FieldDescription>{t('kubecode.members.defaults.configHint')}</FieldDescription>
          {rows.map((row, index) => (
            <Field
              data-invalid={row.key === lockedKey || undefined}
              key={index}
              orientation="horizontal"
            >
              <Input
                aria-describedby={row.key === lockedKey ? `${fieldId}-mode-locked` : undefined}
                aria-invalid={row.key === lockedKey || undefined}
                aria-label={`${t('kubecode.members.defaults.configKey')} ${index + 1}`}
                value={row.key}
                onChange={(event) => setRows(rows.map((r, i) => i === index ? { ...r, key: event.target.value } : r))}
              />
              <Input
                aria-label={`${t('kubecode.members.defaults.configValue')} ${index + 1}`}
                value={row.value}
                onChange={(event) => setRows(rows.map((r, i) => i === index ? { ...r, value: event.target.value } : r))}
              />
              <IconButton
                icon={<X aria-hidden size={14} />}
                label={`${t('kubecode.members.defaults.removeConfig')} ${index + 1}`}
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              />
            </Field>
          ))}
          {lockedKey !== null && (
            <FieldError id={`${fieldId}-mode-locked`}>
              {t('kubecode.members.defaults.modeLocked', { key: lockedKey.trim() })}
            </FieldError>
          )}
          <Button
            className="self-start"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setRows([...rows, { key: '', value: '' }])}
          >
            <Plus data-icon="inline-start" />
            {t('kubecode.members.defaults.addConfig')}
          </Button>
        </FieldSet>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-instructions`}>{t('kubecode.members.defaults.generalInstructions')}</FieldLabel>
          <Textarea
            id={`${fieldId}-instructions`}
            rows={6}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        <Alert role="note">
          <Lock />
          <AlertDescription>{t('kubecode.members.defaults.boundary')}</AlertDescription>
        </Alert>
        <FieldSet>
          <FieldLegend variant="label">{t('kubecode.members.defaults.templates')}</FieldLegend>
          <FieldDescription>{t('kubecode.members.defaults.templatesHint')}</FieldDescription>
          {SPECIALIST_TEMPLATES.filter((template) => template !== 'custom').map((template) => (
            <Field key={template}>
              <FieldLabel htmlFor={`${fieldId}-template-${template}`}>
                {t('kubecode.members.defaults.templateInstructions', { role: t(TEMPLATE_LABELS[template]) })}
              </FieldLabel>
              <Textarea
                id={`${fieldId}-template-${template}`}
                rows={3}
                value={templates[template] ?? ''}
                onChange={(event) => setTemplates({ ...templates, [template]: event.target.value })}
              />
            </Field>
          ))}
        </FieldSet>
        {message && (message.tone === 'error'
          ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{message.text}</AlertDescription>
            </Alert>
          )
          : <FieldDescription role="status">{message.text}</FieldDescription>)}
        <Field orientation="horizontal">
          <Button disabled={busy || !dirty || lockedKey !== null} size="sm" type="submit">
            {busy && <Spinner aria-hidden="true" data-icon="inline-start" />}
            {t('kubecode.members.save')}
          </Button>
          {dirty && (
            <Button size="sm" type="button" variant="ghost" onClick={() => adopt(saved)}>
              {t('kubecode.members.cancel')}
            </Button>
          )}
        </Field>
        </FieldGroup>
      </form>
    </section>
  )
}
