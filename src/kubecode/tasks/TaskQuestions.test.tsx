import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi } from '../api'
import { fakeServices } from '../app/inspector/inspectorTesting'
import { InspectorServicesContext } from '../app/inspector/inspectorContext'
import { createPlaceMemory, type PlaceMemory } from '../app/location/placeMemory'
import { PlaceMemoryProvider } from '../app/location/PlaceMemoryProvider'
import { taskDetail } from './taskFixtures'
import { TaskQuestions } from './TaskQuestions'

const question = {
  id: 'q1', work_id: 'w1', work_title: 'Sweep', question: 'Which ratio?', options: ['0.3', '0.5'],
  impact: 'decides the sweep', asked_by: 's', state: 'open', answer: null, created_at: '',
} as never

function view(memory: PlaceMemory, api: KubecodeApi, onChanged = vi.fn()) {
  return (
    <PlaceMemoryProvider memory={memory}>
      <InspectorServicesContext.Provider value={fakeServices({ api })}>
        <TaskQuestions detail={taskDetail({ open_questions: [question] })} projectId="p1" onChanged={onChanged} />
      </InspectorServicesContext.Provider>
    </PlaceMemoryProvider>
  )
}

describe('TaskQuestions', () => {
  it('answers a specialist\'s question in place with one of its options', async () => {
    const api = { answerWorkDecision: vi.fn().mockResolvedValue(undefined) } as unknown as KubecodeApi
    const onChanged = vi.fn()
    render(view(createPlaceMemory(), api, onChanged))
    expect(screen.getByText('Which ratio?')).toBeInTheDocument()
    expect(screen.getByText('decides the sweep')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '0.5' }))
    await waitFor(() => expect(api.answerWorkDecision).toHaveBeenCalledWith('p1', 'w1', 'q1', '0.5'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('keeps an unsent answer when the Task is left and opened again', () => {
    const api = { answerWorkDecision: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as KubecodeApi
    const memory = createPlaceMemory()
    const first = render(view(memory, api))
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Try 0.4 first' } })
    first.unmount()
    render(view(memory, api))
    expect(screen.getByLabelText('Your answer')).toHaveValue('Try 0.4 first')
  })

  it('says when an answer could not be sent', async () => {
    const api = { answerWorkDecision: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as KubecodeApi
    render(view(createPlaceMemory(), api))
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '0.4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  })
})
