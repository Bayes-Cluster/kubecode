import { useId, useState, type ReactNode } from 'react'

import {
  BlurSwap,
  SegmentedControl,
  ShimmerBlock,
  ShimmerText,
  Ticker,
  ThinkingLoader,
} from '@/components/agent-ui'
import { Button } from '@/components/ui/button'
import type { Translator } from '@/lib/i18n'

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
export function AgentUiMatrix({ t }: { t: Translator }) {
  const [phase, setPhase] = useState(0)
  const [done, setDone] = useState(false)
  const [count, setCount] = useState(128)
  const [swapped, setSwapped] = useState(false)
  const [layout, setLayout] = useState('list')
  const [tray, setTray] = useState('board')

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
    </Section>
  )
}
