import { beforeEach, describe, expect, it } from 'vitest'

import {
  readProjectWorkbenchLayout,
  readWorkbenchNavigatorLayout,
  writeProjectWorkbenchLayout,
  writeWorkbenchNavigatorLayout,
} from './workbenchLayout'

describe('workbench layout preferences', () => {
  beforeEach(() => localStorage.clear())

  it('migrates the legacy project layout into the global navigator and project panels', () => {
    localStorage.setItem('kubecode:layout:project-1', JSON.stringify({
      contextOpen: false,
      contextWidth: 612,
      sessionSidebarOpen: false,
      sessionSidebarWidth: 357,
      terminalHeight: 389,
      terminalOpen: true,
    }))

    expect(readWorkbenchNavigatorLayout(localStorage, 'project-1')).toEqual({
      expandedProjectIds: ['project-1'],
      navigatorOpen: false,
      navigatorWidth: 357,
    })
    expect(readProjectWorkbenchLayout(localStorage, 'project-1')).toEqual({
      contextOpen: false,
      contextWidth: 612,
      terminalHeight: 389,
      terminalOpen: true,
    })
  })

  it('persists versioned navigator and project panel state independently', () => {
    writeWorkbenchNavigatorLayout(localStorage, {
      expandedProjectIds: ['project-1', 'project-2'],
      navigatorOpen: true,
      navigatorWidth: 304,
    })
    writeProjectWorkbenchLayout(localStorage, 'project-1', {
      contextOpen: true,
      contextWidth: 480,
      terminalHeight: 300,
      terminalOpen: false,
    })

    expect(readWorkbenchNavigatorLayout(localStorage, 'project-2')).toEqual({
      expandedProjectIds: ['project-1', 'project-2'],
      navigatorOpen: true,
      navigatorWidth: 304,
    })
    expect(readProjectWorkbenchLayout(localStorage, 'project-1')).toEqual({
      contextOpen: true,
      contextWidth: 480,
      terminalHeight: 300,
      terminalOpen: false,
    })
  })

  it('normalizes invalid stored values without discarding valid project ids', () => {
    localStorage.setItem('kubecode:workbench-layout:v2', JSON.stringify({
      expandedProjectIds: ['project-1', 42, '', 'project-1'],
      navigatorOpen: 'yes',
      navigatorWidth: Number.POSITIVE_INFINITY,
    }))

    expect(readWorkbenchNavigatorLayout(localStorage, 'project-2')).toEqual({
      expandedProjectIds: ['project-1'],
      navigatorOpen: true,
      navigatorWidth: 280,
    })
  })
})
