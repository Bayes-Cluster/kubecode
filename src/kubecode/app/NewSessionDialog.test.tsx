import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { KubecodeApi } from '../api'
import { NewSessionDialog } from './NewSessionDialog'

describe('NewSessionDialog', () => {
  it('names a Team left unnamed in the researcher’s language, not the server’s English default', async () => {
    const createTeam = vi.fn().mockResolvedValue({ id: 'team-1' })
    render(
      <NewSessionDialog
        agents={[{ id: 'codex', available: true, version: '1', executable: 'codex', error: null }]}
        api={{ createTeam } as unknown as KubecodeApi}
        open
        project={{ id: 'project-1', name: 'Demo', path: '/demo' } as never}
        projectId="project-1"
        t={createTranslator('de-DE')}
        onOpenAgentSettings={vi.fn()}
        onOpenChange={vi.fn()}
        onRefreshAgents={vi.fn().mockResolvedValue(undefined)}
        onSession={vi.fn()}
        onTeam={vi.fn()}
      />,
    )
    const t = createTranslator('de-DE')
    fireEvent.click(screen.getByRole('radio', { name: t('kubecode.teamSession') }))
    fireEvent.click(screen.getByRole('button', { name: t('kubecode.create') }))
    await waitFor(() => expect(createTeam).toHaveBeenCalled())
    expect(createTeam.mock.calls[0][3]).toBe(t('kubecode.teamSession'))
  })
})
