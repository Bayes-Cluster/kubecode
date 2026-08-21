import {
  Archive,
  ArrowRightLeft,
  Ban,
  BellRing,
  CheckCheck,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CirclePause,
  CirclePlay,
  CircleX,
  ClipboardList,
  FolderGit2,
  Hammer,
  Hand,
  Hourglass,
  LoaderCircle,
  MessageCircle,
  Minus,
  Moon,
  PenLine,
  Pencil,
  Plug,
  Plus,
  Rocket,
  SearchCheck,
  ShieldCheck,
  Square,
  TriangleAlert,
  Unplug,
  UserMinus,
  UserX,
  Users,
  Wrench,
} from 'lucide-react'

import type { TranslationKey } from '@/lib/i18n'

import type { AgentDescriptor, RunStatus, TeamMember, TeamStatus } from '../api'
import type { NotificationCategory } from '../notificationPreferences'
import type { SessionPlanEntry } from '../session/sessionModel'

import type { IconSource } from './Icon'

/**
 * One semantic status glyph. `cue` is the non-color distinguisher required by
 * ADR 0209: within a family every cue is unique so states stay distinguishable
 * without relying on color alone. `labelKey` always resolves through the i18n
 * catalog; render with the Icon primitive (`role="status"`).
 */
export type StatusIconEntry = {
  Icon: IconSource
  labelKey: TranslationKey
  cue: string
}

export const RUN_STATUS_ICONS: Record<RunStatus, StatusIconEntry> = {
  running: { Icon: LoaderCircle, labelKey: 'kubecode.status.run.running', cue: 'spinner' },
  waiting_permission: { Icon: Hand, labelKey: 'kubecode.status.run.waitingPermission', cue: 'hand' },
  completed: { Icon: CircleCheck, labelKey: 'kubecode.status.run.completed', cue: 'check' },
  failed: { Icon: CircleX, labelKey: 'kubecode.status.run.failed', cue: 'x' },
  cancelled: { Icon: Ban, labelKey: 'kubecode.status.run.cancelled', cue: 'slash' },
  timed_out: { Icon: Hourglass, labelKey: 'kubecode.status.run.timedOut', cue: 'hourglass' },
  interrupted: { Icon: Square, labelKey: 'kubecode.status.run.interrupted', cue: 'stop' },
}

export const TEAM_STATUS_ICONS: Record<TeamStatus, StatusIconEntry> = {
  draft: { Icon: Pencil, labelKey: 'kubecode.status.team.draft', cue: 'pencil' },
  starting: { Icon: Rocket, labelKey: 'kubecode.status.team.starting', cue: 'rocket' },
  active: { Icon: CirclePlay, labelKey: 'kubecode.status.team.active', cue: 'play' },
  paused: { Icon: CirclePause, labelKey: 'kubecode.status.team.paused', cue: 'pause' },
  verifying: { Icon: ShieldCheck, labelKey: 'kubecode.status.team.verifying', cue: 'shield-check' },
  needs_attention: { Icon: BellRing, labelKey: 'kubecode.status.team.needsAttention', cue: 'bell' },
  completed: { Icon: CircleCheck, labelKey: 'kubecode.status.team.completed', cue: 'check' },
  archived: { Icon: Archive, labelKey: 'kubecode.status.team.archived', cue: 'archive' },
  disbanding: { Icon: Users, labelKey: 'kubecode.status.team.disbanding', cue: 'users' },
  removed: { Icon: UserX, labelKey: 'kubecode.status.team.removed', cue: 'user-x' },
}

export const TEAM_MEMBER_STATUS_ICONS: Record<TeamMember['status'], StatusIconEntry> = {
  starting: { Icon: Rocket, labelKey: 'kubecode.status.teamMember.starting', cue: 'rocket' },
  configuring: { Icon: Wrench, labelKey: 'kubecode.status.teamMember.configuring', cue: 'wrench' },
  queued: { Icon: Hourglass, labelKey: 'kubecode.status.teamMember.queued', cue: 'hourglass' },
  idle: { Icon: Moon, labelKey: 'kubecode.status.teamMember.idle', cue: 'moon' },
  working: { Icon: Hammer, labelKey: 'kubecode.status.teamMember.working', cue: 'hammer' },
  waiting_input: {
    Icon: MessageCircle,
    labelKey: 'kubecode.status.teamMember.waitingInput',
    cue: 'message',
  },
  waiting_permission: {
    Icon: Hand,
    labelKey: 'kubecode.status.teamMember.waitingPermission',
    cue: 'hand',
  },
  failed: { Icon: CircleX, labelKey: 'kubecode.status.teamMember.failed', cue: 'x' },
  stopped: { Icon: Square, labelKey: 'kubecode.status.teamMember.stopped', cue: 'stop' },
  removing: { Icon: UserMinus, labelKey: 'kubecode.status.teamMember.removing', cue: 'user-minus' },
  removed: { Icon: UserX, labelKey: 'kubecode.status.teamMember.removed', cue: 'user-x' },
}

/** Task statuses produced by the team runtime (TeamTask.status is a string). */
export type TeamTaskStatusState =
  | 'pending'
  | 'in_progress'
  | 'plan_review'
  | 'result_review'
  | 'changes_requested'
  | 'accepted'
  | 'blocked'
  | 'cancelled'
  | 'done'

export const TEAM_TASK_STATUS_ICONS: Record<TeamTaskStatusState, StatusIconEntry> = {
  pending: { Icon: CircleDashed, labelKey: 'kubecode.status.teamTask.pending', cue: 'circle-dashed' },
  in_progress: {
    Icon: LoaderCircle,
    labelKey: 'kubecode.status.teamTask.inProgress',
    cue: 'spinner',
  },
  plan_review: {
    Icon: ClipboardList,
    labelKey: 'kubecode.status.teamTask.planReview',
    cue: 'clipboard',
  },
  result_review: {
    Icon: SearchCheck,
    labelKey: 'kubecode.status.teamTask.resultReview',
    cue: 'search-check',
  },
  changes_requested: {
    Icon: PenLine,
    labelKey: 'kubecode.status.teamTask.changesRequested',
    cue: 'pen',
  },
  accepted: { Icon: CircleCheck, labelKey: 'kubecode.status.teamTask.accepted', cue: 'check' },
  blocked: { Icon: Ban, labelKey: 'kubecode.status.teamTask.blocked', cue: 'slash' },
  cancelled: { Icon: CircleX, labelKey: 'kubecode.status.teamTask.cancelled', cue: 'x' },
  done: { Icon: CheckCheck, labelKey: 'kubecode.status.teamTask.done', cue: 'double-check' },
}

/** Fallback for statuses the runtime may introduce without a UI contract. */
export function teamTaskStatusIcon(status: string): StatusIconEntry {
  return TEAM_TASK_STATUS_ICONS[status as TeamTaskStatusState] ?? TEAM_TASK_STATUS_ICONS.pending
}

export const PLAN_STATUS_ICONS: Record<SessionPlanEntry['status'], StatusIconEntry> = {
  completed: { Icon: CircleCheck, labelKey: 'kubecode.status.plan.completed', cue: 'check' },
  in_progress: { Icon: LoaderCircle, labelKey: 'kubecode.status.plan.inProgress', cue: 'spinner' },
  pending: { Icon: CircleDashed, labelKey: 'kubecode.status.plan.pending', cue: 'circle-dashed' },
}

export const CONNECTION_STATUS_ICONS: Record<AgentDescriptor['readiness'], StatusIconEntry> = {
  ready: { Icon: CircleCheck, labelKey: 'kubecode.status.connection.ready', cue: 'check' },
  degraded: { Icon: TriangleAlert, labelKey: 'kubecode.status.connection.degraded', cue: 'warning' },
  unavailable: { Icon: Unplug, labelKey: 'kubecode.status.connection.unavailable', cue: 'unplug' },
}

export const NOTIFICATION_STATUS_ICONS: Record<NotificationCategory, StatusIconEntry> = {
  completion: { Icon: CircleCheck, labelKey: 'kubecode.status.notification.completion', cue: 'check' },
  attention: { Icon: BellRing, labelKey: 'kubecode.status.notification.attention', cue: 'bell' },
  error: { Icon: CircleX, labelKey: 'kubecode.status.notification.error', cue: 'x' },
}

export type GitState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export const GIT_STATE_ICONS: Record<GitState, StatusIconEntry> = {
  modified: { Icon: PenLine, labelKey: 'kubecode.status.git.modified', cue: 'pen' },
  added: { Icon: Plus, labelKey: 'kubecode.status.git.added', cue: 'plus' },
  deleted: { Icon: Minus, labelKey: 'kubecode.status.git.deleted', cue: 'minus' },
  renamed: { Icon: ArrowRightLeft, labelKey: 'kubecode.status.git.renamed', cue: 'arrows' },
  untracked: { Icon: CircleHelp, labelKey: 'kubecode.status.git.untracked', cue: 'question' },
}

export type IdentityRole = 'project' | 'team' | 'provider'

export const IDENTITY_ICONS: Record<IdentityRole, StatusIconEntry> = {
  project: { Icon: FolderGit2, labelKey: 'kubecode.status.identity.project', cue: 'folder-git' },
  team: { Icon: Users, labelKey: 'kubecode.status.identity.team', cue: 'users' },
  provider: { Icon: Plug, labelKey: 'kubecode.status.identity.provider', cue: 'plug' },
}

/** All families, for tests that assert invariants across every entry. */
export const STATUS_ICON_FAMILIES = {
  run: RUN_STATUS_ICONS,
  team: TEAM_STATUS_ICONS,
  teamMember: TEAM_MEMBER_STATUS_ICONS,
  teamTask: TEAM_TASK_STATUS_ICONS,
  plan: PLAN_STATUS_ICONS,
  connection: CONNECTION_STATUS_ICONS,
  notification: NOTIFICATION_STATUS_ICONS,
  git: GIT_STATE_ICONS,
  identity: IDENTITY_ICONS,
} as const

