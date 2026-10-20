import { fireEvent, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation, KubecodeApi } from '../api'
import { fakeNavigation, fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import type { ResearchWorkspaceProps } from '../research/ResearchWorkspace'
import type { TaskInspectorProps } from './TaskInspector'

vi.mock('../research/ResearchWorkspace', () => ({
  ResearchWorkspace: (props: ResearchWorkspaceProps) => {
    const { onTitle } = props
    useEffect(() => { onTitle?.('Pruning heads') }, [onTitle])
    return (
      <section aria-label={`task ${props.researchId}`} data-starts-rounds={String(props.startsRounds)}>
        {props.back && <button type="button" onClick={props.back.onBack}>{props.back.label}</button>}
        {props.close && <button type="button" onClick={props.close.onClose}>{props.close.label}</button>}
        {props.inspector}
        <button type="button" onClick={() => props.onOpenSession('s1')}>open session</button>
        <button type="button" onClick={() => props.onOpenBoard?.({ research_id: 'r1' })}>open board</button>
        <button type="button" onClick={() => props.onOpenThread?.('t1')}>open thread</button>
        <button type="button" onClick={() => props.onConversationCreated({ id: 's9' } as Conversation)}>start discussion</button>
      </section>
    )
  },
}))

vi.mock('./TaskInspector', () => ({
  TaskInspector: (props: TaskInspectorProps) => (
    <div>
      <button type="button" onClick={() => props.onInspectEvidence?.({ kind: 'artifact', id: 'a1', revision: '3f' })}>
        inspect artifact
      </button>
      <button type="button" onClick={() => props.onInspectEvidence?.({ kind: 'unknown', id: 'x' })}>inspect unknown</button>
      <button type="button" onClick={() => props.onShowMessage('m1')}>show message</button>
    </div>
  ),
}))

function api() {
  return {
    readProjectContext: vi.fn().mockResolvedValue({
      ref: { kind: 'artifact', id: 'a1', revision: '3f' },
      detail: 'content',
      title: 'accuracy.csv',
      availability: 'available',
      provenance: {},
      sections: [{ heading: 'Rows', text: 'acc 0.91', truncated: false }],
      related: [],
      next_cursor: null,
      notes: [],
    }),
  } as unknown as KubecodeApi
}

describe('TaskPanel', () => {
  it('renders the Task record with the inspector Close and no rounds of its own', () => {
    renderInspector({ services: fakeServices({ api: api() }), stack: [{ kind: 'task', id: 'r1' }] })
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'task r1' })).toHaveAttribute('data-starts-rounds', 'false')
    expect(screen.getByRole('button', { name: 'Close details' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument()
  })

  it('goes back to the view over it on a phone', () => {
    renderInspector({
      presentation: 'screen',
      services: fakeServices({ api: api() }),
      stack: [{ kind: 'task', id: 'r1' }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back to General' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('pushes review evidence over the Task, and Back returns to the Task with focus on the evidence', async () => {
    renderInspector({ services: fakeServices({ api: api() }), stack: [{ kind: 'task', id: 'r1' }] })
    const opener = screen.getByRole('button', { name: 'inspect artifact' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('complementary', { name: 'Evidence details' })).toBeInTheDocument()
    expect(await screen.findByText('acc 0.91')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pruning heads' }))
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'inspect artifact' })).toHaveFocus()
  })

  it('ignores evidence of a kind it cannot show', () => {
    renderInspector({ services: fakeServices({ api: api() }), stack: [{ kind: 'task', id: 'r1' }] })
    fireEvent.click(screen.getByRole('button', { name: 'inspect unknown' }))
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeInTheDocument()
  })

  it('leaves for other places through the Workspace navigation', () => {
    const navigation = fakeNavigation()
    const services = fakeServices({ api: api() })
    renderInspector({ navigation, services, stack: [{ kind: 'task', id: 'r1' }] })
    fireEvent.click(screen.getByRole('button', { name: 'open session' }))
    expect(navigation.openSession).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByRole('button', { name: 'open board' }))
    expect(navigation.openPlace).toHaveBeenLastCalledWith({ view: 'board' }, { inspect: { kind: 'task', id: 'r1' } })
    fireEvent.click(screen.getByRole('button', { name: 'open thread' }))
    expect(navigation.openPlace).toHaveBeenLastCalledWith({ view: 'general', thread: 't1' })
    fireEvent.click(screen.getByRole('button', { name: 'show message' }))
    expect(navigation.openPlace).toHaveBeenLastCalledWith({ view: 'general', message: 'm1', thread: null })
    fireEvent.click(screen.getByRole('button', { name: 'start discussion' }))
    expect(services.onConversationCreated).toHaveBeenCalledWith({ id: 's9' })
  })
})
