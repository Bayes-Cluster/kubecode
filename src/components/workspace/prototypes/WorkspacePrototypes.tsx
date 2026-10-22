import { useEffect, useState } from 'react'

import { Icon } from '@/kubecode/icons'
import { WORKSPACE_DESTINATION_ICONS } from '@/kubecode/icons/workspaceIcons'
import { createTranslator, type TranslationKey } from '@/lib/i18n'
import { applyThemeModeToDocument } from '@/lib/themeMode'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'

import { AgentsMain, WorkQueue } from './AgentsPrototype'
import { FIXTURE_MEMBERS } from './fixtures'
import { GeneralMain, Materials } from './GeneralPrototype'
import {
  PROTOTYPE_SCREENS,
  PROTOTYPE_STATES,
  prototypeHash,
  prototypeRequest,
  type PrototypeRequest,
  type PrototypeScreen,
  type PrototypeState,
} from './prototypeRoute'
import { EvidenceDetail, ReviewMain } from './ReviewPrototype'
import type { ScreenParts, ScreenProps } from './shared'

const SCREEN_NAMES: Record<PrototypeScreen, TranslationKey> = {
  general: 'kubecode.proto.screen.general',
  agents: 'kubecode.proto.screen.agents',
  review: 'kubecode.proto.screen.review',
}

const STATE_NAMES: Record<PrototypeState, TranslationKey> = {
  default: 'kubecode.proto.state.default',
  busy: 'kubecode.matrix.state.busy',
  error: 'kubecode.proto.state.error',
  empty: 'kubecode.proto.state.empty',
}

function screenParts({ go, request, t }: ScreenProps): ScreenParts {
  switch (request.screen) {
    case 'agents':
      return { main: <AgentsMain request={request} t={t} />, inspector: <WorkQueue request={request} t={t} />, inspectorLabel: t('kubecode.proto.work') }
    case 'review':
      return { main: <ReviewMain go={go} request={request} t={t} />, inspector: <EvidenceDetail state={request.state} t={t} />, inspectorLabel: t('kubecode.proto.review.evidence') }
    default:
      return { main: <GeneralMain request={request} t={t} />, inspector: <Materials t={t} />, inspectorLabel: t('kubecode.proto.materials') }
  }
}

/**
 * Connected Workspace prototypes on fixture data (ADR 0233), at
 * `#/prototypes`: the shell's three regions — places, the main view, one
 * inspector — with production components, in every theme and language.
 * Nothing here talks to a server.
 */
export function WorkspacePrototypes({ request }: { request: PrototypeRequest }) {
  const t = createTranslator(request.locale)
  const go = (change: Partial<PrototypeRequest>) => {
    window.location.assign(prototypeHash({ ...request, ...change }))
  }
  const parts = screenParts({ go, request, t })
  const link = (change: Partial<PrototypeRequest>) => prototypeHash({ ...request, ...change })
  const place = (screen: PrototypeScreen | null) => request.screen === screen ? 'page' as const : undefined
  const generalPlace = request.screen === 'general' || (request.screen === 'agents') ? 'page' as const : undefined

  return (
    <div className="kubecode-app kubecode-proto" data-screen={request.screen} data-state={request.state} data-testid="workspace-prototypes">
      <div className="kubecode-proto-bar">
        <p className="kubecode-proto-fixture" role="note">
          <Badge variant="outline">{t('kubecode.proto.fixture.badge')}</Badge>
          <span>{t('kubecode.proto.fixture.body')}</span>
        </p>
        <nav aria-label={t('kubecode.proto.screens')} className="kubecode-proto-switcher">
          <ul>
            {PROTOTYPE_SCREENS.map((screen) => (
              <li key={screen}>
                <a aria-current={place(screen)} href={link({ screen, state: 'default' })}>{t(SCREEN_NAMES[screen])}</a>
              </li>
            ))}
          </ul>
          <ul aria-label={t('kubecode.proto.states')}>
            {PROTOTYPE_STATES.map((state) => (
              <li key={state}>
                <a aria-current={request.state === state ? 'true' : undefined} href={link({ state })}>{t(STATE_NAMES[state])}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="kubecode-proto-frame">
        <nav aria-label={t('kubecode.proto.places')} className="kubecode-proto-places">
          <p className="kubecode-proto-workspace">Sparse attention study</p>
          <ul>
            <li>
              <a aria-current={generalPlace} href={link({ screen: 'general', state: 'default' })}>
                <Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.general.Icon} />
                <span>{t('kubecode.channel.general')}</span>
              </a>
            </li>
            <li>
              <a aria-current={place('review')} href={link({ screen: 'review', state: 'default', from: 'general' })}>
                <Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.board.Icon} />
                <span>{t('kubecode.vocab.destination.board')}</span>
              </a>
            </li>
            <li>
              <a href={link({ screen: 'agents', state: 'default' })}>
                <Icon role="navigation" source={WORKSPACE_DESTINATION_ICONS.needsYou.Icon} />
                <span>{t('kubecode.vocab.destination.needsYou')}</span>
                <Badge variant="secondary">1</Badge>
              </a>
            </li>
          </ul>
          <p className="kubecode-proto-places-heading">{t('kubecode.proto.directMessages')}</p>
          <ul>
            <li className="kubecode-proto-dm">
              <Avatar className="size-5"><AvatarFallback>A</AvatarFallback></Avatar>
              <span>{FIXTURE_MEMBERS.ada.name}</span>
              <small>{t('kubecode.proto.dmPrivate')}</small>
            </li>
          </ul>
        </nav>
        <main className="kubecode-proto-main">{parts.main}</main>
        <aside aria-label={parts.inspectorLabel} className="kubecode-proto-inspector">{parts.inspector}</aside>
      </div>
    </div>
  )
}

/** Follows the hash, so links between screens, states, themes, and languages work. */
export function WorkspacePrototypesRoute({ initial }: { initial: PrototypeRequest }) {
  const [request, setRequest] = useState(initial)
  useEffect(() => {
    const follow = () => {
      const next = prototypeRequest(window.location.hash)
      if (!next) {
        window.location.reload()
        return
      }
      applyThemeModeToDocument(document, next.theme)
      document.documentElement.lang = next.locale
      setRequest(next)
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  // A new screen starts fresh: fixture state does not carry across.
  return <WorkspacePrototypes key={prototypeHash(request)} request={request} />
}
