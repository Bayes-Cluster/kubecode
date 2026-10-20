/**
 * The Workspace's attention store (ADR 0232), shared by Needs you, the Task
 * panel, the Working-now strip and the notifications so one answer resolves
 * everywhere at once. Null outside the shell, so components still render alone.
 */

import { createContext, useContext } from 'react'

import { ApiError, type AttentionItem, type AttentionSnapshot, type ExecutionFailure, type ExecutionView } from '../api'

/** Whose executions: General's members, one member's DM, or the work on one Task. */
export type ExecutionScope = { binding: 'public' } | { binding: 'dm'; memberId: string } | { taskId: string }

export type AttentionStore = {
  projectId: string | null
  snapshot: AttentionSnapshot | null
  status: 'loading' | 'ready' | 'error'
  forTask(taskId: string): AttentionItem[]
  byKey(key: string): AttentionItem | undefined
  executions(scope: ExecutionScope): ExecutionView[]
  failures(scope: ExecutionScope): ExecutionFailure[]
  /** Keys answered and not yet dropped by a newer snapshot. */
  resolving: ReadonlySet<string>
  /**
   * Runs the call that answers `key`. On success the key stays resolving until
   * a snapshot read after the call omits it (or ten seconds pass); on failure
   * it is given back and the error rethrown. Items are never removed here.
   */
  markResolving<T>(key: string, call: () => Promise<T>): Promise<T>
  reload(): void
}

export const AttentionContext = createContext<AttentionStore | null>(null)

export function useAttention(): AttentionStore | null {
  return useContext(AttentionContext)
}

/** Answers through the store when there is one, so every surface updates together. */
export function resolveThrough<T>(store: AttentionStore | null, key: string, call: () => Promise<T>): Promise<T> {
  return store ? store.markResolving(key, call) : call()
}

/** A refusal that means the request no longer exists: answered elsewhere, timed out, or its turn stopped. */
export function isGone(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404
}
