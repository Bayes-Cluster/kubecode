import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ChannelThread, KubecodeApi } from '../api'
import { ResearchThreadsPanel } from './ResearchThreadsPanel'

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}:${JSON.stringify(values)}` : key
)) as never

const thread = (id: string, researchId: string | null): ChannelThread => ({
  id, project_id: 'p1', channel_id: 'c1', root_message_id: `m-${id}`, title: `Title ${id}`,
  research_id: researchId, round_id: null, revision: 1, reply_count: 2, last_seq: 3,
  created_by: null, created_at: '', updated_at: '',
})

function api(threads: ChannelThread[]) {
  return {
    listChannels: vi.fn(async () => [{ id: 'c1', is_default: true }]),
    listChannelThreads: vi.fn(async () => threads),
  } as unknown as KubecodeApi
}

describe('ResearchThreadsPanel', () => {
  it('lists only the Threads linked to this question and opens one', async () => {
    const onOpenThread = vi.fn()
    render(
      <ResearchThreadsPanel
        api={api([thread('a', 'r1'), thread('b', 'r2'), thread('c', null)])}
        connectionState="live"
        events={[]}
        onOpenThread={onOpenThread}
        projectId="p1"
        researchId="r1"
        t={t}
      />,
    )
    expect(await screen.findByText('Title a')).toBeInTheDocument()
    expect(screen.queryByText('Title b')).not.toBeInTheDocument()
    expect(screen.queryByText('Title c')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'kubecode.channel.openThread' }))
    expect(onOpenThread).toHaveBeenCalledWith('a')
  })

  it('says when nothing is linked yet', async () => {
    render(
      <ResearchThreadsPanel
        api={api([thread('b', 'r2')])}
        connectionState="live"
        events={[]}
        onOpenThread={vi.fn()}
        projectId="p1"
        researchId="r1"
        t={t}
      />,
    )
    expect(await screen.findByText('kubecode.channel.noLinkedThreads')).toBeInTheDocument()
  })
})
