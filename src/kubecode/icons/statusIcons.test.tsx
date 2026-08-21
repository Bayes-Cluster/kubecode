import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'

import EN_TRANSLATIONS from '@/lib/locales/en.json'

import type { AgentDescriptor, RunStatus, TeamMember, TeamStatus } from '../api'
import { NOTIFICATION_CATEGORIES } from '../notificationPreferences'
import type { SessionPlanEntry } from '../session/sessionModel'

import { Icon } from './Icon'
import {
  GIT_STATE_ICONS,
  IDENTITY_ICONS,
  NOTIFICATION_STATUS_ICONS,
  PLAN_STATUS_ICONS,
  RUN_STATUS_ICONS,
  STATUS_ICON_FAMILIES,
  TEAM_MEMBER_STATUS_ICONS,
  TEAM_STATUS_ICONS,
  TEAM_TASK_STATUS_ICONS,
  teamTaskStatusIcon,
  type StatusIconEntry,
} from './statusIcons'

const RUN_STATES: RunStatus[] = [
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]
const TEAM_STATES: TeamStatus[] = [
  'draft',
  'starting',
  'active',
  'paused',
  'verifying',
  'needs_attention',
  'completed',
  'archived',
  'disbanding',
  'removed',
]
const MEMBER_STATES = Object.keys(TEAM_MEMBER_STATUS_ICONS) as Array<TeamMember['status']>
const PLAN_STATES: SessionPlanEntry['status'][] = ['completed', 'in_progress', 'pending']
const READINESS_STATES: AgentDescriptor['readiness'][] = ['ready', 'degraded', 'unavailable']

describe('status icon families', () => {
  it('covers every RunStatus state', () => {
    expect(Object.keys(RUN_STATUS_ICONS).sort()).toEqual([...RUN_STATES].sort())
  })

  it('covers every TeamStatus state', () => {
    expect(Object.keys(TEAM_STATUS_ICONS).sort()).toEqual([...TEAM_STATES].sort())
  })

  it('covers every team member status state', () => {
    const memberStates: Array<TeamMember['status']> = [
      'starting',
      'configuring',
      'queued',
      'idle',
      'working',
      'waiting_input',
      'waiting_permission',
      'failed',
      'stopped',
      'removing',
      'removed',
    ]
    expect(Object.keys(TEAM_MEMBER_STATUS_ICONS).sort()).toEqual([...memberStates].sort())
    expect(MEMBER_STATES).toHaveLength(memberStates.length)
  })

  it('covers every plan entry status state', () => {
    expect(Object.keys(PLAN_STATUS_ICONS).sort()).toEqual([...PLAN_STATES].sort())
  })

  it('covers every agent readiness state', () => {
    expect(Object.keys(STATUS_ICON_FAMILIES.connection).sort()).toEqual(
      [...READINESS_STATES].sort(),
    )
  })

  it('covers every notification category', () => {
    expect(Object.keys(NOTIFICATION_STATUS_ICONS).sort()).toEqual(
      [...NOTIFICATION_CATEGORIES].sort(),
    )
  })

  it('gives every entry in a family a unique non-color cue', () => {
    for (const [familyName, family] of Object.entries(STATUS_ICON_FAMILIES)) {
      const cues = Object.values(family as Record<string, StatusIconEntry>).map((entry) => entry.cue)
      expect(new Set(cues).size, `family ${familyName} has duplicate cues`).toBe(cues.length)
    }
  })

  it('resolves every labelKey against the English catalog', () => {
    for (const [familyName, family] of Object.entries(STATUS_ICON_FAMILIES)) {
      for (const [state, entry] of Object.entries(family as Record<string, StatusIconEntry>)) {
        expect(
          EN_TRANSLATIONS[entry.labelKey as keyof typeof EN_TRANSLATIONS],
          `${familyName}.${state} labelKey ${entry.labelKey}`,
        ).toBeTruthy()
      }
    }
  })

  it('renders every entry as a labeled root svg via the Icon primitive', () => {
    for (const [familyName, family] of Object.entries(STATUS_ICON_FAMILIES)) {
      for (const [state, entry] of Object.entries(family as Record<string, StatusIconEntry>)) {
        const { container, getByRole } = render(
          <TooltipProvider>
            <Icon
              label={`${familyName}.${state}`}
              role="status"
              size="secondary"
              source={entry.Icon}
            />
          </TooltipProvider>,
        )
        expect(container.firstElementChild?.tagName.toLowerCase()).toBe('svg')
        expect(getByRole('img', { name: `${familyName}.${state}` })).toBeInTheDocument()
      }
    }
  })

  it('falls back to the pending glyph for unknown team task statuses', () => {
    expect(teamTaskStatusIcon('accepted').cue).toBe('check')
    expect(teamTaskStatusIcon('brand-new-state')).toBe(TEAM_TASK_STATUS_ICONS.pending)
  })

  it('defines git states and identity roles', () => {
    expect(Object.keys(GIT_STATE_ICONS).sort()).toEqual(
      ['added', 'deleted', 'modified', 'renamed', 'untracked'],
    )
    expect(Object.keys(IDENTITY_ICONS).sort()).toEqual(['project', 'provider', 'team'])
  })
})
