import { useId, useMemo, useState, type ReactNode } from 'react'

import { Icon } from '@/kubecode/icons'
import {
  WORKSPACE_COMMAND_ICONS,
  WORKSPACE_DESTINATION_ICONS,
  WORKSPACE_OBJECT_ICONS,
  type WorkspaceIconEntry,
  type WorkspaceObjectKind,
} from '@/kubecode/icons/workspaceIcons'
import { translate, type AppLocale, type TranslationKey, type TranslationValues, type Translator } from '@/lib/i18n'

import { Composer } from './Composer'
import { RecipientRow } from './RecipientRow'
import { longestTranslation } from './controlMatrixRoute'
import { DecisionButton } from './DecisionButton'
import { IconButton } from './IconButton'
import { MemberIdentity } from './MemberIdentity'
import { MoreActions } from './MoreActions'
import { OfficialComponentMatrix } from './OfficialComponentMatrix'
import { ReferenceChip } from './ReferenceChip'
import { PauseButton, SendButton, StopButton } from './SendButton'
import { StatusBadge } from './StatusBadge'
import { ViewHeader } from './ViewHeader'

function Row({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="kubecode-control-matrix-row">
      <span className="kubecode-control-matrix-state">{label}</span>
      <div className="kubecode-control-matrix-cells">{children}</div>
    </div>
  )
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="kubecode-control-matrix-section">
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  )
}

/** An icon button with its name written under it, so a reviewer can read the glyph's meaning. */
function Captioned({ entry, role, t }: { entry: WorkspaceIconEntry; role: 'navigation' | 'command'; t: Translator }) {
  return (
    <span className="kubecode-control-matrix-caption">
      <IconButton icon={<Icon role={role} source={entry.Icon} />} label={t(entry.labelKey)} />
      <span aria-hidden="true">{t(entry.labelKey)}</span>
    </span>
  )
}

/**
 * Every shared Workspace control in each of its states (ADR 0227), outside the
 * Workspace shell, so both themes, keyboard focus, accessible names, long
 * translations, and touch targets can be checked in one place.
 */
export function ControlMatrix({ t }: { t: Translator }) {
  const [draft, setDraft] = useState('')
  const [paused, setPaused] = useState(false)
  const [cited, setCited] = useState(true)
  // Each long sample is written in one locale — the one whose translation of
  // its main label is longest — and marked with that language.
  const long = useMemo(() => {
    const sample = (key: TranslationKey) => {
      const { locale } = longestTranslation(key)
      return { locale, in: (other: TranslationKey, values?: TranslationValues) => translate(locale, other, values) }
    }
    return {
      accept: sample('kubecode.task.acceptResults'),
      sendBack: sample('kubecode.task.sendBack'),
      identity: sample('kubecode.matrix.sample.managerRole'),
      reference: sample('kubecode.matrix.sample.longTitle'),
      reason: sample('kubecode.matrix.sample.disabledReason'),
      recipient: sample('kubecode.channel.recipientUnavailable'),
    }
  }, [])
  const lang = (locale: AppLocale, children: ReactNode) => <span lang={locale}>{children}</span>
  const objectKinds = Object.keys(WORKSPACE_OBJECT_ICONS) as WorkspaceObjectKind[]
  const object = (kind: WorkspaceObjectKind) => t(WORKSPACE_OBJECT_ICONS[kind].labelKey)

  return (
    <main className="kubecode-app kubecode-control-matrix" data-testid="control-matrix">
      <ViewHeader description={t('kubecode.matrix.description')} level={1} title={t('kubecode.matrix.title')} />

      <Section title={t('kubecode.matrix.section.destinations')}>
        <Row label={t('kubecode.matrix.state.default')}>
          {Object.entries(WORKSPACE_DESTINATION_ICONS).map(([meaning, entry]) => (
            <Captioned entry={entry} key={meaning} role="navigation" t={t} />
          ))}
        </Row>
      </Section>

      <Section title={t('kubecode.matrix.section.commands')}>
        <Row label={t('kubecode.matrix.state.default')}>
          {Object.entries(WORKSPACE_COMMAND_ICONS).map(([meaning, entry]) => (
            <Captioned entry={entry} key={meaning} role="command" t={t} />
          ))}
        </Row>
        <Row label={t('kubecode.matrix.state.disabled')}>
          <IconButton disabled icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.reply.Icon} />} label={t('kubecode.vocab.command.reply')} />
          <IconButton disabled icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.share.Icon} />} label={t('kubecode.vocab.command.share')} />
        </Row>
        <Row label={t('kubecode.matrix.state.busy')}>
          <IconButton busy icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.retry.Icon} />} label={t('kubecode.vocab.command.retry')} />
        </Row>
        <Row label={t('kubecode.matrix.state.menu')}>
          <MoreActions
            items={[
              { id: 'copy', label: t('kubecode.vocab.command.copyLink'), onSelect: () => undefined },
              { id: 'share', label: t('kubecode.vocab.command.share'), onSelect: () => undefined },
            ]}
            label={t('kubecode.vocab.command.more')}
          />
        </Row>
      </Section>

      <Section title={t('kubecode.matrix.section.sendStop')}>
        <Row label={t('kubecode.matrix.state.default')}>
          <SendButton canSend label={t('kubecode.vocab.command.send')} onSend={() => undefined} />
          <StopButton label={t('kubecode.matrix.sample.stopAnalyst')} shortLabel={t('kubecode.vocab.command.stopRun')} onStop={() => undefined} />
          <PauseButton label={t('kubecode.matrix.sample.pauseWork')} paused={paused} onToggle={() => setPaused(!paused)} />
        </Row>
        <Row label={t('kubecode.matrix.state.disabled')}>
          <SendButton canSend={false} label={t('kubecode.vocab.command.send')} onSend={() => undefined} />
        </Row>
        <Row label={t('kubecode.matrix.state.busy')}>
          <SendButton busy canSend label={t('kubecode.vocab.command.send')} onSend={() => undefined} />
          <PauseButton busy label={t('kubecode.matrix.sample.pauseWork')} paused={false} onToggle={() => undefined} />
        </Row>
      </Section>

      <Section title={t('kubecode.matrix.section.decisions')}>
        <Row label={t('kubecode.matrix.state.default')}>
          <DecisionButton variant="primary" onDecide={() => undefined}>{t('kubecode.task.acceptResults')}</DecisionButton>
          <DecisionButton onDecide={() => undefined}>{t('kubecode.task.sendBack')}</DecisionButton>
          <DecisionButton variant="destructive" onDecide={() => undefined}>{t('kubecode.vocab.command.remove')}</DecisionButton>
        </Row>
        <Row label={t('kubecode.matrix.state.disabled')}>
          <DecisionButton
            disabledReason={t('kubecode.matrix.sample.disabledReason')}
            variant="primary"
            onDecide={() => undefined}
          >
            {t('kubecode.task.acceptResults')}
          </DecisionButton>
        </Row>
        <Row label={t('kubecode.matrix.state.busy')}>
          <DecisionButton busy variant="primary" onDecide={() => undefined}>{t('kubecode.task.acceptResults')}</DecisionButton>
        </Row>
        <Row label={t('kubecode.matrix.state.longest')}>
          <div className="kubecode-control-matrix-narrow">
            {lang(long.accept.locale, (
              <DecisionButton variant="primary" onDecide={() => undefined}>{long.accept.in('kubecode.task.acceptResults')}</DecisionButton>
            ))}
            {lang(long.sendBack.locale, (
              <DecisionButton onDecide={() => undefined}>{long.sendBack.in('kubecode.task.sendBack')}</DecisionButton>
            ))}
            {lang(long.reason.locale, (
              <DecisionButton disabledReason={long.reason.in('kubecode.matrix.sample.disabledReason')} onDecide={() => undefined}>
                {long.reason.in('kubecode.task.acceptResults')}
              </DecisionButton>
            ))}
          </div>
          <div className="kubecode-control-matrix-tight" data-testid="decision-wrap-sample">
            {lang(long.reference.locale, (
              <DecisionButton onDecide={() => undefined}>{long.reference.in('kubecode.matrix.sample.longTitle')}</DecisionButton>
            ))}
          </div>
        </Row>
      </Section>

      <Section title={t('kubecode.matrix.section.status')}>
        <Row label={t('kubecode.matrix.state.default')}>
          <StatusBadge tone="muted">{t('kubecode.matrix.sample.muted')}</StatusBadge>
          <StatusBadge tone="info">{t('kubecode.matrix.sample.info')}</StatusBadge>
          <StatusBadge tone="ok">{t('kubecode.matrix.sample.ok')}</StatusBadge>
          <StatusBadge tone="warn">{t('kubecode.matrix.sample.needsSetup')}</StatusBadge>
          <StatusBadge tone="danger">{t('kubecode.matrix.sample.danger')}</StatusBadge>
        </Row>
      </Section>

      <Section title={t('kubecode.matrix.section.identity')}>
        <Row label={t('kubecode.matrix.state.default')}>
          <MemberIdentity handle="general" name="General" role="manager" roleLabel={t('kubecode.matrix.sample.managerRole')} />
          <MemberIdentity
            activity={t('kubecode.matrix.sample.running')}
            handle="analyst"
            name="Data Analyst"
            role="specialist"
            roleLabel={t('kubecode.matrix.sample.specialistRole')}
            onOpen={() => undefined}
          />
          <MemberIdentity meta="10:42" name={t('kubecode.matrix.sample.you')} role="researcher" />
          <MemberIdentity name="Kubecode" role="system" size="sm" />
        </Row>
        <Row label={t('kubecode.matrix.state.attention')}>
          <MemberIdentity
            attention={{ label: t('kubecode.matrix.sample.needsSetup'), tone: 'warn' }}
            handle="writer"
            name="Writer"
            role="specialist"
            roleLabel={t('kubecode.matrix.sample.specialistRole')}
          />
        </Row>
        <Row label={t('kubecode.matrix.state.longest')}>
          <div className="kubecode-control-matrix-narrow">
            {lang(long.identity.locale, (
              <MemberIdentity
                attention={{ label: long.identity.in('kubecode.matrix.sample.needsSetup'), tone: 'warn' }}
                handle="general"
                name="General"
                role="manager"
                roleLabel={long.identity.in('kubecode.matrix.sample.managerRole')}
              />
            ))}
          </div>
        </Row>
      </Section>

      <Section title={t('kubecode.matrix.section.references')}>
        <Row label={t('kubecode.matrix.state.default')}>
          {objectKinds.map((kind) => (
            <ReferenceChip key={kind} kind={kind} kindLabel={object(kind)} title={object(kind)} onOpen={() => undefined} />
          ))}
        </Row>
        <Row label={t('kubecode.matrix.state.versioned')}>
          <ReferenceChip kind="evidence" kindLabel={object('evidence')} title="results.csv" version="v3" onOpen={() => undefined} />
          <ReferenceChip
            kind="file"
            kindLabel={object('file')}
            state={{ kind: 'changed', label: t('kubecode.matrix.sample.changed') }}
            title="notes.md"
            onOpen={() => undefined}
          />
          <ReferenceChip
            kind="file"
            kindLabel={object('file')}
            state={{ kind: 'removed', label: t('kubecode.matrix.sample.removed') }}
            title="old.csv"
          />
          <ReferenceChip
            kind="discussion"
            kindLabel={object('discussion')}
            state={{ kind: 'unavailable', label: t('kubecode.matrix.sample.unavailable') }}
            title="Private notes"
            onOpen={() => undefined}
          />
        </Row>
        <Row label={t('kubecode.matrix.state.removable')}>
          {cited && (
            <ReferenceChip
              kind="evidence"
              kindLabel={object('evidence')}
              removeLabel={t('kubecode.matrix.sample.remove', { title: 'results.csv' })}
              title="results.csv"
              version="v3"
              onOpen={() => undefined}
              onRemove={() => {
                setCited(false)
                // The chip is gone; focus moves on to the text box, as in a real draft.
                document.querySelector<HTMLTextAreaElement>('.kubecode-control-matrix textarea')?.focus()
              }}
            />
          )}
        </Row>
        <Row label={t('kubecode.matrix.state.longest')}>
          <div className="kubecode-control-matrix-narrow">
            {lang(long.reference.locale, (
              <ReferenceChip
                kind="evidence"
                kindLabel={long.reference.in('kubecode.vocab.object.evidence')}
                state={{ kind: 'changed', label: long.reference.in('kubecode.matrix.sample.changed') }}
                title={long.reference.in('kubecode.matrix.sample.longTitle')}
                version="v12"
                onOpen={() => undefined}
              />
            ))}
          </div>
        </Row>
      </Section>

      <Section title={t('kubecode.matrix.section.headers')}>
        <ViewHeader
          actions={<IconButton icon={<Icon role="command" source={WORKSPACE_COMMAND_ICONS.add.Icon} />} label={t('kubecode.vocab.command.add')} />}
          description={t('kubecode.matrix.sample.headerDescription')}
          icon={<Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.members.Icon} />}
          title={t('kubecode.vocab.destination.members')}
        />
        <ViewHeader
          close={{ label: t('kubecode.vocab.command.close'), onClose: () => undefined }}
          level={3}
          meta={<StatusBadge tone="info">{t('kubecode.matrix.sample.info')}</StatusBadge>}
          title="Structured pruning"
        />
        <div className="kubecode-control-matrix-narrow">
          {lang(long.reference.locale, (
            <ViewHeader
              back={{ label: long.reference.in('kubecode.vocab.command.back'), onBack: () => undefined }}
              level={3}
              title={long.reference.in('kubecode.matrix.sample.longTitle')}
            />
          ))}
        </div>
      </Section>

      <Section title={t('kubecode.matrix.section.composer')}>
        <Composer
          busyLabel={t('kubecode.matrix.sample.sending')}
          label={t('kubecode.matrix.sample.composerLabel')}
          mentionLabel={t('kubecode.matrix.sample.mentionLabel')}
          mentions={[
            { id: 'general', handle: 'general', label: 'General' },
            { id: 'analyst', handle: 'analyst', label: 'Data Analyst' },
          ]}
          placeholder={t('kubecode.matrix.sample.composerLabel')}
          sendLabel={t('kubecode.vocab.command.send')}
          stop={{ label: t('kubecode.matrix.sample.stopAnalyst'), shortLabel: t('kubecode.vocab.command.stopRun'), onStop: () => undefined }}
          value={draft}
          onChange={setDraft}
          onSend={() => setDraft('')}
        />
        <div className="kubecode-control-matrix-narrow">
          {lang(long.recipient.locale, (() => {
            const say = long.recipient.in
            const writer = 'Writer'
            const blocked = say('kubecode.channel.recipientUnavailable', {
              name: writer,
              state: say('kubecode.members.state.setup_required'),
            })
            return (
              <Composer
                below={(
                  <>
                    <RecipientRow
                      label={say('kubecode.channel.to')}
                      recipients={[
                        {
                          key: 'analyst', name: 'Data Analyst', handle: 'analyst', role: 'specialist',
                          roleLabel: say('kubecode.identity.specialist', { responsibility: say('kubecode.members.template.analysis') }),
                          removeLabel: say('kubecode.channel.removeRecipient', { name: 'Data Analyst' }),
                          onRemove: () => undefined,
                        },
                        {
                          key: 'writer', name: writer, handle: 'writer', role: 'specialist',
                          attention: { label: say('kubecode.members.state.setup_required'), tone: 'warn' },
                          removeLabel: say('kubecode.channel.removeRecipient', { name: writer }),
                          onRemove: () => undefined,
                        },
                      ]}
                    />
                    <p className="kubecode-composer-warning" role="status">{blocked}</p>
                  </>
                )}
                canSend={false}
                label={say('kubecode.channel.composerPlaceholder')}
                placeholder={say('kubecode.channel.composerPlaceholder')}
                sendDisabledReason={blocked}
                sendLabel={say('kubecode.vocab.command.send')}
                value="@analyst @writer"
                onChange={() => undefined}
                onSend={() => undefined}
              />
            )
          })())}
        </div>
        <Composer
          disabled
          label={t('kubecode.matrix.sample.composerDisabled')}
          placeholder={t('kubecode.matrix.sample.composerDisabled')}
          sendLabel={t('kubecode.vocab.command.send')}
          value=""
          onChange={() => undefined}
          onSend={() => undefined}
        />
      </Section>

      <OfficialComponentMatrix t={t} />
    </main>
  )
}
