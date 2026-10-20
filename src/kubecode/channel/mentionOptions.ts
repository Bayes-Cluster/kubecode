import type { MentionOption } from '@/components/workspace/mentions'
import type { Translator } from '@/lib/i18n'

import { canReceive, type MemberDirectory } from '../members/memberDirectory'
import { memberView } from '../members/memberIdentity'

/**
 * The members a General message can `@mention`: every live member, by member
 * id, in the shared identity. One who cannot receive is still offered, and
 * says so; the draft then says why it cannot be sent (ADR 0229 §2).
 */
export function mentionOptions(directory: MemberDirectory, t: Translator): MentionOption[] {
  return directory.live.map((item) => {
    const view = memberView(item, t)
    return {
      id: item.id,
      handle: item.handle,
      label: item.name,
      identity: {
        role: view.role,
        roleLabel: view.roleLabel,
        ...(canReceive(item) ? {} : { unavailable: t('kubecode.identity.cannotReceive') }),
      },
    }
  })
}
