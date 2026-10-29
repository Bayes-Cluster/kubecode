import { useId, useState, type ReactNode } from 'react'

import {
  BlurSwap,
  CommandMenuFeedback,
  CommandMenuPill,
  CopyAction,
  PlanRail,
  highlightMatch,
  SegmentedControl,
  ShimmerBlock,
  ShimmerText,
  SourceList,
  Ticker,
  ThinkingLoader,
} from '@/components/agent-ui'
import { AiActionCard } from '@/components/AiActionCard'
import {
  AgxBoard,
  AgxBoardCardBody,
  AgxBoardCard,
  AgxBoardChips,
  AgxBoardChip,
  AgxBoardColumn,
  AgxBoardColumns,
  AgxBoardDrop,
  AgxComposerChip,
  AgxFilterChip,
  AgxFilterGroup,
  AgxFilterMenu,
  AgxFilterOption,
  AgxModelPickerToggle,
  AgxPickerFill,
  AgxPickerFoot,
  AgxPickerGroup,
  AgxPickerRow,
} from '@/components/agent-ui'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import type { AppLocale, Translator } from '@/lib/i18n'
import { ConversationComposer } from '@/kubecode/channel/ConversationComposer'

function Section({ children, title }: { children: ReactNode; title: string }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="kubecode-control-matrix-section">
      <h2 id={id}>{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Row({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="kubecode-control-matrix-row">
      <span className="kubecode-control-matrix-state">{label}</span>
      <div className="kubecode-control-matrix-cells">{children}</div>
    </div>
  )
}

const PHASES = ['kubecode.matrix.sample.thinkingPhase', 'kubecode.matrix.sample.thinkingNext', 'kubecode.matrix.sample.thinkingLast'] as const

/**
 * The agent-ui presentation primitives (ADR 0257) in their states, with
 * deterministic fixtures and every label from the locale catalogs. The
 * moving states advance only through the visible controls — a fixture is a
 * stand-in for a real event, never a timer. The toast presentation is not
 * shown here: its host is global and stays the app's one Sonner mount.
 */
export function AgentUiMatrix({ locale = 'en', t }: { locale?: AppLocale; t: Translator }) {
  const [phase, setPhase] = useState(0)
  const [done, setDone] = useState(false)
  const [count, setCount] = useState(128)
  const [swapped, setSwapped] = useState(false)
  const [layout, setLayout] = useState('list')
  const [tray, setTray] = useState('board')
  const [commandQuery, setCommandQuery] = useState('')
  const [commandRan, setCommandRan] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [filterOpen, setFilterOpen] = useState(true)
  const [filterPicked, setFilterPicked] = useState(true)

  return (
    <Section title={t('kubecode.matrix.section.agentui')}>
      <Row label={t('kubecode.matrix.state.busy')}>
        <ThinkingLoader label={t(PHASES[phase])} />
        <ThinkingLoader label={t('kubecode.matrix.sample.thinkingPhase')} size="sm" variant="plain" />
      </Row>
      <Row label={t('kubecode.matrix.state.done')}>
        <ThinkingLoader done={done} doneLabel={t('kubecode.matrix.sample.thinkingDone')} label={t(PHASES[phase])} />
        <Button
          onClick={() => {
            setDone(false)
            setPhase((current) => (current + 1) % PHASES.length)
          }}
          size="sm"
          variant="outline"
        >
          {t('kubecode.matrix.sample.advance')}
        </Button>
        <Button onClick={() => setDone(true)} size="sm" variant="outline">
          {t('kubecode.matrix.sample.settle')}
        </Button>
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        <span aria-busy="true" className="flex items-center gap-3">
          <ShimmerBlock circle width={28} />
          <span className="flex flex-col gap-1.5">
            <ShimmerBlock height={10} radius={5} width={120} />
            <ShimmerBlock height={8} radius={4} width={72} />
          </span>
          <ShimmerText>{t('kubecode.matrix.sample.generating')}</ShimmerText>
        </span>
      </Row>
      <Row label={t('kubecode.matrix.state.updating')}>
        <span className="flex items-center gap-3">
          <span className="text-lg">
            <Ticker value={count} />
          </span>
          <Button onClick={() => setCount((current) => current + 47)} size="sm" variant="outline">
            {t('kubecode.matrix.sample.countUp')}
          </Button>
        </span>
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        <BlurSwap swapKey={swapped ? 'b' : 'a'}>
          <p className="m-0">
            {swapped ? t('kubecode.matrix.sample.swapped') : t('kubecode.matrix.sample.swapSource')}
          </p>
        </BlurSwap>
        <Button onClick={() => setSwapped((current) => !current)} size="sm" variant="outline">
          {t('kubecode.matrix.sample.swap')}
        </Button>
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        <SegmentedControl
          aria-label={t('kubecode.matrix.sample.layoutView')}
          onChange={setLayout}
          options={[
            { value: 'list', label: t('kubecode.matrix.sample.viewList') },
            { value: 'board', label: t('kubecode.matrix.sample.viewBoard') },
            { value: 'chart', label: t('kubecode.matrix.sample.viewChart') },
          ]}
          value={layout}
        />
        <SegmentedControl
          aria-label={t('kubecode.matrix.sample.detailView')}
          onChange={setTray}
          options={[
            { value: 'board', label: t('kubecode.matrix.sample.viewBoard') },
            { value: 'notes', label: t('kubecode.matrix.sample.viewNotes'), count: 3 },
            { value: 'mine', label: t('kubecode.matrix.sample.viewMine'), disabled: true },
          ]}
          size="sm"
          value={tray}
          variant="tray"
        />
      </Row>
      <Row label={t('kubecode.matrix.state.disabled')}>
        <SegmentedControl
          aria-label={t('kubecode.matrix.sample.disabledView')}
          defaultValue="list"
          disabled
          options={[
            { value: 'list', label: t('kubecode.matrix.sample.viewList') },
            { value: 'board', label: t('kubecode.matrix.sample.viewBoard') },
          ]}
        />
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        <div className="kubecode-control-matrix-narrow">
          <SourceList
            aria-label={t('kubecode.channel.references')}
            closeLabel={t('kubecode.vocab.command.close')}
            openLabel={t('kubecode.matrix.sample.openRecord')}
            previewLabel={t('kubecode.channel.references')}
            sources={[
              { id: 'file', kindLabel: t('kubecode.vocab.object.file'), title: 'results.csv', versionLabel: 'v3' },
              {
                id: 'evidence',
                kindLabel: t('kubecode.vocab.object.evidence'),
                title: 'baseline-run',
                state: { tone: 'warn', label: t('kubecode.matrix.sample.changed') },
              },
              {
                id: 'gone',
                kindLabel: t('kubecode.vocab.object.file'),
                title: 'draft-notes.md',
                state: { tone: 'error', label: t('kubecode.matrix.sample.unavailable') },
              },
              {
                id: 'pending',
                kindLabel: t('kubecode.vocab.object.evidence'),
                title: 'follow-up',
                state: { tone: 'loading', label: t('kubecode.reference.checking') },
              },
            ]}
          />
        </div>
      </Row>
      <Row label={t('kubecode.matrix.state.busy')}>
        {/* The session's production tool card: running and done, the glyph
            resolving between them (ADR 0257, slice E2). */}
        <AiActionCard
          expanded={false}
          label="read_file src/kubecode/session/sessionModel.ts"
          locale={locale}
          status="pending"
          tool="read_file"
          onToggle={() => undefined}
        />
        <AiActionCard
          expanded
          input='{"path": "src/kubecode/session/sessionModel.ts"}'
          label="read_file src/kubecode/session/sessionModel.ts"
          locale="en"
          output="export type SessionPlanEntry = {...}"
          status="done"
          tool="read_file"
          onToggle={() => undefined}
        />
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        <div className="kubecode-control-matrix-narrow">
          <PlanRail
            aria-label={t('kubecode.agentPlan')}
            entries={[
              { content: t('kubecode.matrix.sample.viewList'), status: 'completed' },
              { content: t('kubecode.matrix.sample.viewBoard'), status: 'in_progress' },
              { content: t('kubecode.matrix.sample.viewChart'), status: 'pending' },
            ]}
            statusLabels={{
              completed: t('kubecode.status.plan.completed'),
              in_progress: t('kubecode.status.plan.inProgress'),
              pending: t('kubecode.status.plan.pending'),
            }}
          />
        </div>
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        <div className="kubecode-control-matrix-narrow">
          {/* The palette's own engine (cmdk) under the shared presentation
              (ADR 0257, slice C): the pill reads cmdk's selection, the query
              marks the items, and running one settles into the feedback. */}
          <Command shouldFilter={false} className="rounded-lg border bg-card">
            <CommandInput
              className="h-10"
              onValueChange={(next) => {
                setCommandQuery(next)
                setCommandRan(null)
              }}
              placeholder={t('command.palettePlaceholder')}
              value={commandQuery}
            />
            <CommandList className="agx-cmd__list">
              <CommandMenuPill />
              <CommandGroup heading={t('kubecode.matrix.section.commands')}>
                {([
                  'kubecode.vocab.command.reply',
                  'kubecode.vocab.command.settings',
                  'kubecode.channel.copyText',
                ] as const).map((key) => {
                  const label = t(key)
                  return (
                    <CommandItem
                      className="agx-cmd__item"
                      key={key}
                      onSelect={() => setCommandRan(label)}
                    >
                      <span className="min-w-0 truncate">{highlightMatch(label, commandQuery)}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
            <CommandMenuFeedback
              hint={t('kubecode.commandPaletteHintSelect')}
              ranLabel={commandRan}
            />
          </Command>
        </div>
        <CopyAction
          copiedIcon={
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M5.4 8.3l1.9 1.9 3.4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
          copiedLabel={t('kubecode.matrix.sample.copied')}
          errorLabel={t('kubecode.matrix.sample.copyRetry')}
          getText={() => t('kubecode.matrix.sample.swapSource')}
          icon={
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          }
          label={t('kubecode.matrix.sample.copyAnswer')}
        />
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        {/* The shared board presentation (ADR 0257, slice G): tray columns
            with live counts, the fact chips, the drop indicator and the
            empty lane. A visual specimen; the Work board owns legality. */}
        <div className="kubecode-control-matrix-narrow">
          <AgxBoard>
            <AgxBoardColumns>
              <AgxBoardColumn count={1} label={t('kubecode.work.stage.executing')}>
                <AgxBoardCard>
                  <AgxBoardCardBody>
                    <span className="agx-board__card-secondary agx-pick__hint">{t('kubecode.matrix.sample.viewBoard')}</span>
                    <AgxBoardChips>
                      <AgxBoardChip tone="warn">{t('kubecode.matrix.sample.running')}</AgxBoardChip>
                    </AgxBoardChips>
                  </AgxBoardCardBody>
                </AgxBoardCard>
                <AgxBoardDrop />
              </AgxBoardColumn>
              <AgxBoardColumn count={0} emptyLabel={t('kubecode.matrix.sample.needsSetup')} label={t('kubecode.work.stage.review')} />
            </AgxBoardColumns>
          </AgxBoard>
        </div>
        <div className="kubecode-control-matrix-narrow">
          <AgxFilterMenu
            chips={filterPicked ? <AgxFilterChip>{t('kubecode.matrix.sample.viewChart')}</AgxFilterChip> : undefined}
            clearDisabled={false}
            clearLabel={t('kubecode.work.filter.clear')}
            title={t('kubecode.work.filters')}
            onClear={() => setFilterPicked(false)}
          >
            <AgxFilterGroup count={2} label={t('kubecode.matrix.sample.detailView')} onOpenChange={setFilterOpen} open={filterOpen} picked={filterPicked ? t('kubecode.matrix.sample.viewChart') : undefined}>
              <AgxFilterOption checked={filterPicked} label={t('kubecode.matrix.sample.viewChart')} onToggle={() => setFilterPicked((v) => !v)} />
              <AgxFilterOption checked={false} disabled label={t('kubecode.matrix.sample.viewNotes')} onToggle={() => undefined} />
            </AgxFilterGroup>
          </AgxFilterMenu>
        </div>
      </Row>
      <Row label={t('kubecode.matrix.state.default')}>
        {/* The channel composer's production card (ADR 0257, slice E1): the
            inset field, its chips and the action rail, with the draft held
            here as the fixture's own state. */}
        <div className="kubecode-control-matrix-narrow">
          <ConversationComposer
            attachLabel={t('kubecode.vocab.command.attachFile')}
            header={(
              <AgxComposerChip label={t('kubecode.matrix.sample.changed')}>
                {t('kubecode.matrix.sample.changed')}
              </AgxComposerChip>
            )}
            label={t('kubecode.matrix.sample.composerLabel')}
            placeholder={t('kubecode.matrix.sample.composerLabel')}
            sendLabel={t('kubecode.channel.send')}
            stop={{
              label: t('kubecode.matrix.sample.stopAnalyst'),
              onStop: () => undefined,
              shortLabel: t('kubecode.vocab.command.stopRun'),
            }}
            value={draft}
            onChange={setDraft}
            onSend={() => undefined}
          />
        </div>
        <div className="kubecode-control-matrix-narrow">
          {/* The shared picker presentation (ADR 0257, slice E1): grouped
              rows under the gliding fill, and the switch that draws the
              engine row's checked state. A visual specimen — no roles: the
              production pickers carry the real semantics. */}
          <div className="agx-pick rounded-lg border bg-card">
            <AgxPickerFill />
            <AgxPickerGroup label={t('kubecode.matrix.sample.mentionLabel')}>
              {/* Short sample words: the narrow samples wrap instead of
                  clipping, so the fixture shows no ellipsis. */}
              <div className="agx-pick__row" data-selected="true">
                <AgxPickerRow hint="@general" name={t('kubecode.matrix.sample.viewBoard')} />
              </div>
              <div className="agx-pick__row">
                <AgxPickerRow hint="@analyst" name={t('kubecode.matrix.sample.viewChart')} />
              </div>
            </AgxPickerGroup>
            <AgxPickerFoot count="2" />
          </div>
          <div className="agx-pick rounded-lg border bg-card">
            <div className="agx-pick__slot" data-state="checked">
              <AgxModelPickerToggle label={t('kubecode.matrix.sample.sending')} />
            </div>
            <div className="agx-pick__slot">
              <AgxModelPickerToggle label={t('kubecode.matrix.sample.needsSetup')} />
            </div>
          </div>
        </div>
      </Row>
    </Section>
  )
}
