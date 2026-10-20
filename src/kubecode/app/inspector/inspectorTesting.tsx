/**
 * Test support: an inspector stack with the shell's contexts around it, so a
 * panel can be tested the way the shell shows it. Not used by the app.
 */

import { render } from '@testing-library/react'
import { useState } from 'react'
import { vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi } from '../../api'
import { AttentionContext, type AttentionStore } from '../../attention/attentionContext'
import { applyInspect, popEntry, type InspectorStack } from '../location/inspector'
import { WorkspaceNavigationContext, type WorkspaceNavigation } from '../location/WorkspaceNavigation'
import { InspectorServicesContext, type InspectorServices } from './inspectorContext'
import { InspectorPane } from './InspectorPane'
import { INSPECTOR_PANELS, type InspectorPanels } from './inspectorPanels'
import type { InspectorPresentation } from './useInspectorPresentation'

export function fakeNavigation(overrides: Partial<WorkspaceNavigation> = {}): WorkspaceNavigation {
  return {
    projectId: 'p1',
    location: { place: { view: 'general' }, inspector: [] },
    presentation: 'side',
    openPlace: vi.fn(),
    patchGeneral: vi.fn(),
    inspect: vi.fn(),
    openTaskFromMessage: vi.fn(),
    openReference: vi.fn(),
    openSession: vi.fn(),
    switchWorkspace: vi.fn(),
    ...overrides,
  }
}

export function fakeServices(overrides: Partial<InspectorServices> = {}): InspectorServices {
  return {
    agents: [],
    api: {} as KubecodeApi,
    connectionState: 'live',
    events: [],
    roster: [],
    sessionCatalog: [],
    t: createTranslator('en'),
    teams: [],
    onConversationCreated: vi.fn(),
    ...overrides,
  }
}

/** Renders `stack` in an InspectorPane whose Back, Close, and push work like the shell's. */
export function renderInspector({
  attention = null,
  navigation = fakeNavigation(),
  panels = INSPECTOR_PANELS,
  presentation = 'side',
  services = fakeServices(),
  stack,
}: {
  /** The Workspace's attention store, as the shell provides it (ADR 0232). */
  attention?: AttentionStore | null
  navigation?: WorkspaceNavigation
  panels?: InspectorPanels
  presentation?: InspectorPresentation
  services?: InspectorServices
  stack: InspectorStack
}) {
  function Host() {
    const [current, setCurrent] = useState<InspectorStack>(stack)
    return (
      <InspectorPane
        originLabel="General"
        panels={panels}
        presentation={presentation}
        projectId="p1"
        stack={current}
        t={services.t}
        onBack={() => setCurrent(popEntry)}
        onClose={() => setCurrent([])}
        onPush={(entry) => setCurrent((value) => applyInspect(value, entry, 'push'))}
        onReplace={(entry) => setCurrent((value) => applyInspect(value, entry, 'replace'))}
      />
    )
  }
  const view = render(
    <WorkspaceNavigationContext.Provider value={navigation}>
      <InspectorServicesContext.Provider value={services}>
        <AttentionContext.Provider value={attention}>
          <Host />
        </AttentionContext.Provider>
      </InspectorServicesContext.Provider>
    </WorkspaceNavigationContext.Provider>,
  )
  return { ...view, navigation, services }
}
