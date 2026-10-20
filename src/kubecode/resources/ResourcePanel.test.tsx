import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi } from '../api'
import { fakeServices, renderInspector } from '../app/inspector/inspectorTesting'

describe('ResourcePanel', () => {
  it('shows a Project record live, in the inspector, with only Close beside the view', async () => {
    const readProjectContext = vi.fn().mockResolvedValue({
      ref: { kind: 'finding', id: 'f1', revision: 'r9' },
      detail: 'content',
      title: 'Pruning keeps accuracy',
      availability: 'available',
      provenance: {},
      sections: [{ heading: 'Claim', text: 'Accuracy held at 0.91', truncated: false }],
      related: [],
      next_cursor: null,
      notes: [],
    })
    renderInspector({
      services: fakeServices({ api: { readProjectContext } as unknown as KubecodeApi }),
      stack: [{ kind: 'resource', ref: { kind: 'finding', id: 'f1' } }],
    })
    expect(screen.getByRole('complementary', { name: 'Resource details' })).toBeInTheDocument()
    expect(await screen.findByText('Accuracy held at 0.91')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'finding:f1', level: 3 })).toBeInTheDocument()
    // Live: no pinned revision is asked for, and none is claimed.
    expect(readProjectContext).toHaveBeenCalledWith('p1', { kind: 'finding', id: 'f1' }, 'content')
    expect(screen.queryByText(/Cited at revision/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })
})
