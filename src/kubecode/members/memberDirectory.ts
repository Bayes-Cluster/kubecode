import { createContext, useContext } from 'react'

import type { Member, MemberRoster } from '../api'
import type { MemberLoadStatus } from './useMembers'

/**
 * Everyone a Workspace conversation can name (ADR 0229 §1): the roster with
 * its removed members, read once by the shell and shared by every view, so a
 * message, a recipient, a mention suggestion, and a profile name a member the
 * same way.
 */
export type MemberDirectory = {
  status: MemberLoadStatus
  /** Every member, removed ones too: history keeps their names. */
  byId: ReadonlyMap<string, Member>
  /**
   * Each member's current public Session. Only for messages read without the
   * server's identity projection; an ended Session is never found here.
   */
  byCurrentSession: ReadonlyMap<string, string>
  /** Members that are not removed, the project manager first. */
  live: readonly Member[]
  /** The General Agent, the project manager, when it is a live member. */
  manager: Member | null
  /** Reads the roster again (a send was refused because it was out of date). */
  reload: () => void
}

const NOTHING = () => undefined

export function memberDirectory(
  roster: MemberRoster | null,
  status: MemberLoadStatus,
  reload: () => void = NOTHING,
): MemberDirectory {
  const members = roster?.members ?? []
  const byId = new Map(members.map((item) => [item.id, item]))
  const byCurrentSession = new Map(
    members
      .filter((item) => item.state !== 'removed' && item.public_conversation_id !== null)
      .map((item) => [item.public_conversation_id as string, item.id]),
  )
  const live = members
    .filter((item) => item.state !== 'removed')
    .sort((a, b) => Number(b.role === 'general') - Number(a.role === 'general'))
  const manager = live.find((item) => item.role === 'general') ?? null
  return { status, byId, byCurrentSession, live, manager, reload }
}

/** Whether a member can be sent a message now: active, with a public Session. */
export function canReceive(item: Member): boolean {
  return item.state === 'active' && item.public_conversation_id !== null
}

/** Why a member cannot receive a message, in the server's words for it. */
export function unavailableReason(item: Member): 'needs_setup' | 'removed' | null {
  if (item.state === 'removed') return 'removed'
  return canReceive(item) ? null : 'needs_setup'
}

const EMPTY = memberDirectory(null, 'loading')

export const MemberDirectoryContext = createContext<MemberDirectory>(EMPTY)

/** The active Workspace's members; empty (and loading) outside the shell. */
export function useMemberDirectory(): MemberDirectory {
  return useContext(MemberDirectoryContext)
}
