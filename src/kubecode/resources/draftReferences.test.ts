import { describe, expect, it } from 'vitest'

import { emptyGeneralDraft, toNewMessage, type GeneralDraft } from '../channel/generalDraft'
import { attachToDraft, draftHas, MAX_DRAFT_REFERENCES, type DraftReference } from './draftReferences'

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

  it('says a different Task replaces the one the message was about, and pins the version of the Task attached', () => {
    const task = (id: string, revision: string): DraftReference => ({ ref: { kind: 'research', id, revision }, title: id, seen: 'previewed' })
    const about = emptyGeneralDraft('r1')
    const replaced = attachToDraft(about, task('r2', '3'))
    expect(replaced.result).toBe('replacedTask')
    expect(replaced.draft).toMatchObject({ task: 'r2', taskRevision: '3' })
    // Another version of the same Task is an update, and the same one a duplicate.
    const updated = attachToDraft(replaced.draft, task('r2', '4'))
    expect(updated.result).toBe('replaced')
    expect(updated.draft.taskRevision).toBe('4')
    expect(attachToDraft(updated.draft, task('r2', '4')).result).toBe('duplicate')
    expect(draftHas(updated.draft, task('r2', '4').ref)).toBe(true)
    expect(draftHas(updated.draft, task('r2', '3').ref)).toBe(false)
    // The Task goes at the version that was attached; a Task the draft only filters by goes as current.
    expect(toNewMessage(updated.draft, managerOnly).message.references).toEqual([{ kind: 'research', id: 'r2', revision: '4' }])
    expect(toNewMessage(about, managerOnly).message.references).toEqual([{ kind: 'research', id: 'r1', revision: null }])
    expect(toNewMessage(updated.draft, managerOnly).signature).not.toBe(toNewMessage(replaced.draft, managerOnly).signature)
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
