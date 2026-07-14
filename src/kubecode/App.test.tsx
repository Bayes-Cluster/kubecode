import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { KubecodeApp } from './App'
import type { KubecodeApi } from './api'

describe('Kubecode workspace', () => {
  it('shows registered projects and keeps the empty editor actionable', async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Demo', path: 'demo' },
      ]),
      listAgents: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listTerminals: vi.fn().mockResolvedValue([]),
      listConversations: vi.fn().mockResolvedValue([]),
    } as unknown as KubecodeApi

    render(<KubecodeApp api={api} />)

    expect(await screen.findByRole('button', { name: 'Demo' })).toBeInTheDocument()
    expect(screen.getByText('Select a file to start editing')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New file' })).toHaveLength(2)
  })
})
