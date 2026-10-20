import type { Translator } from '@/lib/i18n'

import { ApiError, type MemberState, type MemberTemplate } from '../api'

export const TEMPLATE_LABELS: Record<MemberTemplate, Parameters<Translator>[0]> = {
  general: 'kubecode.members.template.general',
  analysis: 'kubecode.members.template.analysis',
  writing: 'kubecode.members.template.writing',
  code_review: 'kubecode.members.template.code_review',
  custom: 'kubecode.members.template.custom',
}

/** Membership in words, only where it needs the researcher: an active member has no status (ADR 0229 §1). */
export const STATE_LABELS: Record<Exclude<MemberState, 'active'>, Parameters<Translator>[0]> = {
  setup_required: 'kubecode.members.state.setup_required',
  removed: 'kubecode.members.state.removed',
}

/** Specialist templates a researcher can pick when adding a member. */
export const SPECIALIST_TEMPLATES: MemberTemplate[] = ['analysis', 'writing', 'code_review', 'custom']

/** The words for a failed member command; conflicts say what to do next. */
export function memberErrorMessage(cause: unknown, t: Translator): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case 'member_name_taken': return t('kubecode.members.error.nameTaken')
      case 'member_revision_conflict': return t('kubecode.members.error.stale')
      case 'member_holds_work': return t('kubecode.members.error.holdsWork')
      case 'member_running': return t('kubecode.members.error.running')
      case 'general_protected': return t('kubecode.members.error.generalProtected')
      case 'member_limit': return t('kubecode.members.error.limit')
      default: return cause.message || t('kubecode.error')
    }
  }
  return cause instanceof Error ? cause.message : t('kubecode.error')
}

export function isMemberStale(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === 'member_revision_conflict'
}

/** Config entries as editable rows and back, dropping blank rows. */
export function configRows(config: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(config).map(([key, value]) => ({ key, value }))
}

export function configFromRows(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, value } of rows) {
    if (key.trim() && value.trim()) out[key.trim()] = value.trim()
  }
  return out
}
