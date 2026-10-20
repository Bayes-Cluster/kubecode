import { describe, expect, it } from 'vitest'

import { emptyGeneralDraft, toNewMessage, type GeneralDraft } from '../channel/generalDraft'
import { attachToDraft, MAX_DRAFT_REFERENCES, type DraftReference } from './draftReferences'

const file = (revision: string): DraftReference => ({
  ref: { kind: 'file', id: 'results/summary.csv', revision }, title: 'results/summary.csv', seen: 'previewed',
})
const managerOnly = { kind: 'manager' as const, manager: null }

describe('draft references', () => {
  it('adds a reference once, and replaces it when another version is attached', () => {
    const draft = emptyGeneralDraft(null)
    const added = attachToDraft(draft, file('aaaaaaaaaaaaaaaa'))
    expect(added.result).toBe('added')
    expect(added.draft.references).toEqual([file('aaaaaaaaaaaaaaaa')])
    expect(attachToDraft(added.draft, file('aaaaaaaaaaaaaaaa')).result).toBe('duplicate')
    const replaced = attachToDraft(added.draft, file('bbbbbbbbbbbbbbbb'))
    expect(replaced.result).toBe('replaced')
    expect(replaced.draft.references).toEqual([file('bbbbbbbbbbbbbbbb')])
  })

  it('makes a Task what the message is about instead of a second reference', () => {
    const task: DraftReference = { ref: { kind: 'research', id: 'r2', revision: '3' }, title: 'Prune heads', seen: 'listed' }
    const { draft, result } = attachToDraft({ ...emptyGeneralDraft(null), taskCleared: true }, task)
    expect(result).toBe('added')
    expect(draft).toMatchObject({ task: 'r2', taskCleared: false, references: [] })
    expect(attachToDraft(draft, task).result).toBe('duplicate')
  })

  it('cites at most as many records as the server accepts', () => {
    let draft: GeneralDraft = emptyGeneralDraft(null)
    for (let index = 0; index < MAX_DRAFT_REFERENCES; index += 1) {
      draft = attachToDraft(draft, { ref: { kind: 'finding', id: `f${index}`, revision: '1' }, title: `F${index}`, seen: 'listed' }).draft
    }
    expect(attachToDraft(draft, file('a')).result).toBe('full')
  })

  it('sends each reference at the version that was attached, and a new version is a new message', () => {
    const first = attachToDraft({ ...emptyGeneralDraft(null), body: 'compare' }, file('aaaaaaaaaaaaaaaa')).draft
    const sent = toNewMessage(first, managerOnly)
    expect(sent.message.references).toEqual([{ kind: 'file', id: 'results/summary.csv', revision: 'aaaaaaaaaaaaaaaa' }])
    const again = toNewMessage({ ...first }, managerOnly)
    expect(again.signature).toBe(sent.signature)
    const newer = toNewMessage(attachToDraft(first, file('bbbbbbbbbbbbbbbb')).draft, managerOnly)
    expect(newer.signature).not.toBe(sent.signature)
  })
})
