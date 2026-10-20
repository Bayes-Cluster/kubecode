import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError, type KubecodeApi } from '../api'
import { useInspectionRecord } from '../app/inspector/inspectorContext'
import { InspectorPanel } from '../app/inspector/InspectorPanel'
import { INSPECTOR_PANELS } from '../app/inspector/inspectorPanels'
import { fakeServices, renderInspector } from '../app/inspector/inspectorTesting'
import type { InspectorEntry } from '../app/location/inspector'

/** Stands in for the Task under the evidence: it reads what the stack recorded. */
function RecordProbe() {
  const record = useInspectionRecord()
  const shown = record.displayedRevision({ kind: 'artifact', id: 'a1' })
  const file = record.displayedRevision({ kind: 'file', id: 'results.csv' })
  return (
    <InspectorPanel title="Pruning heads">
      <p>artifact {shown === undefined ? 'never displayed' : `displayed ${shown}`}</p>
      <p>file {file === undefined ? 'never displayed' : `displayed ${file}`}</p>
    </InspectorPanel>
  )
}

const panels = { ...INSPECTOR_PANELS, task: RecordProbe }
const task: InspectorEntry = { kind: 'task', id: 'r1' }

function document(revision: string | null) {
  return {
    ref: { kind: 'artifact', id: 'a1', revision },
    detail: 'content',
    title: 'accuracy.csv',
    availability: 'available',
    provenance: {},
    sections: [{ heading: 'Rows', text: 'acc 0.91', truncated: false }],
    related: [],
    next_cursor: null,
    notes: [],
  }
}

function mount(stackTop: InspectorEntry, api: Partial<KubecodeApi>) {
  return renderInspector({
    panels,
    services: fakeServices({ api: api as KubecodeApi }),
    stack: [task, stackTop],
  })
}

describe('EvidencePanel', () => {
  it('records the version it displayed, which may be newer than the one the Task pinned', async () => {
    const readProjectContext = vi.fn().mockResolvedValue(document('b7'))
    mount({ kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: '3f' } }, { readProjectContext })
    expect(await screen.findByText('acc 0.91')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'artifact:a1', level: 3 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to Pruning heads' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('artifact displayed b7')).toBeInTheDocument())
    expect(readProjectContext).toHaveBeenCalledWith('p1', { kind: 'artifact', id: 'a1' }, 'content')
  })

  it('never records a read that failed', async () => {
    const readProjectContext = vi.fn().mockRejectedValue(new ApiError('internal', 'x', 500))
    mount({ kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: '3f' } }, { readProjectContext })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this record.')
    expect(screen.getByText('artifact never displayed')).toBeInTheDocument()
  })

  it('never records evidence that is gone', async () => {
    const readProjectContext = vi.fn().mockRejectedValue(new ApiError('not_found', 'x', 404))
    mount({ kind: 'evidence', ref: { kind: 'artifact', id: 'a1', revision: '3f' } }, { readProjectContext })
    await screen.findByRole('alert')
    expect(screen.getByText('artifact never displayed')).toBeInTheDocument()
  })

  it('records a Project file at the revision it read', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'acc,0.91', revision: 'f9', path: 'results.csv' })
    mount({ kind: 'evidence', ref: { kind: 'file', id: 'results.csv' } }, { readFile })
    expect(await screen.findByText('acc,0.91')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('file displayed f9')).toBeInTheDocument())
    expect(screen.getByText('artifact never displayed')).toBeInTheDocument()
  })
})
